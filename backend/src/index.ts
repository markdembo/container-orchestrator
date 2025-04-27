import { DurableObject } from 'cloudflare:workers';

interface ContainerState {
	id: string;
	sessionId: string | null;
	ipv6Address: string;
	health: boolean;
	createdAt: number;
	lastActivity: number;
}

type EventType =
	| 'container_created'
	| 'container_allocated'
	| 'container_deallocated'
	| 'container_shutdown'
	| 'container_health_changed'
	| 'pool_size_changed';

interface Event {
	type: EventType;
	containerId: string;
	timestamp: number;
	details: string;
}

interface Env {
	CONTAINER_ORCHESTRATOR: DurableObjectNamespace;
}

/** A Durable Object's behavior is defined in an exported Javascript class */
export class ContainerOrchestrator extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.initializeSchema();
		this.initializePool();
	}

	private async initializeSchema() {
		await this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS containers (
				id TEXT PRIMARY KEY,
				session_id TEXT,
				ipv6_address TEXT,
				health BOOLEAN,
				created_at INTEGER,
				last_activity INTEGER
			);

			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				type TEXT,
				container_id TEXT,
				timestamp INTEGER,
				details TEXT
			);

			CREATE TABLE IF NOT EXISTS pool_config (
				key TEXT PRIMARY KEY,
				value INTEGER
			);

			INSERT OR IGNORE INTO pool_config (key, value) VALUES 
				('min_size', 2),
				('max_size', 10),
				('current_size', 0);
		`);
	}

	private async initializePool() {
		// Check if we need to create initial containers
		const idleCount = await this.ctx.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) as count FROM containers WHERE session_id IS NULL AND health = 'true'`)
			.one().count;

		if (idleCount < 2) {
			// Create containers to reach minimum pool size
			const toCreate = 2 - idleCount;
			for (let i = 0; i < toCreate; i++) {
				try {
					await this.createContainer();
				} catch (e) {
					console.error('Error creating container', e);
				}
			}
		}
	}

	private async createContainer(): Promise<ContainerState> {
		const currentSize = await this.ctx.storage.sql.exec<{ value: number }>(`SELECT value FROM pool_config WHERE key = 'current_size'`).one()
			.value;

		const maxSize = await this.ctx.storage.sql.exec<{ value: number }>(`SELECT value FROM pool_config WHERE key = 'max_size'`).one().value;

		console.log('currentSize', currentSize);
		console.log('maxSize', maxSize);

		if (currentSize >= maxSize) {
			throw new Error(`Cannot create container: pool size limit (${maxSize}) reached`);
		}

		// Simulate container creation delay
		await new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 5000));

		const id = crypto.randomUUID();
		const ipv6Address = `2001:db8::${id.slice(0, 8)}`;
		const now = Date.now();

		await this.ctx.storage.sql.exec(
			`INSERT INTO containers (id, session_id, ipv6_address, health, created_at, last_activity) 
			 VALUES (?, ?, ?, ?, ?, ?)`,
			...[id, null, ipv6Address, true, now, now]
		);

		await this.ctx.storage.sql.exec(`UPDATE pool_config SET value = value + 1 WHERE key = 'current_size'`);

		await this.logEvent({
			type: 'container_created',
			containerId: id,
			timestamp: now,
			details: JSON.stringify({ ipv6Address }),
		});

		return {
			id,
			sessionId: null,
			ipv6Address,
			health: true,
			createdAt: now,
			lastActivity: now,
		};
	}

	private async shutdownExcessContainers() {
		const idleContainers = await this.ctx.storage.sql
			.exec<{ id: string }>(`SELECT id FROM containers WHERE session_id IS NULL AND health = 'true' ORDER BY created_at ASC`)
			.toArray();

		if (idleContainers.length > 2) {
			const excessCount = idleContainers.length - 2;
			const containersToShutdown = idleContainers.slice(0, excessCount);

			for (const container of containersToShutdown) {
				await this.ctx.storage.sql.exec(`DELETE FROM containers WHERE id = ?`, ...[container.id]);

				await this.logEvent({
					type: 'container_shutdown',
					containerId: container.id,
					timestamp: Date.now(),
					details: JSON.stringify({ reason: 'excess_idle_container' }),
				});
			}

			await this.ctx.storage.sql.exec(`UPDATE pool_config SET value = value - ? WHERE key = 'current_size'`, ...[excessCount]);
		}
	}

	private async maintainPool() {
		const idleContainers = await this.ctx.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) as count FROM containers WHERE session_id IS NULL AND health = 'true'`)
			.one().count;

		if (idleContainers < 2) {
			// Create containers to maintain minimum pool size
			const toCreate = 2 - idleContainers;
			for (let i = 0; i < toCreate; i++) {
				try {
					await this.createContainer();
				} catch (e) {
					console.error('Error creating container', e);
				}
			}
		} else if (idleContainers > 2) {
			// Shutdown excess containers
			await this.shutdownExcessContainers();
		}
	}

	private async broadcastEvent(event: Event) {
		const status = await this.getStatus();
		const message = JSON.stringify({
			type: event.type,
			event: event,
			status: status,
		});
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(message);
			} catch (e) {
				// Handle failed sends
			}
		}
	}

	private async logEvent(event: Event) {
		await this.ctx.storage.sql.exec(
			`INSERT INTO events (type, container_id, timestamp, details) VALUES (?, ?, ?, ?)`,
			...[event.type, event.containerId, event.timestamp, event.details]
		);
		await this.broadcastEvent(event);
	}

	async allocateContainer(sessionId: string): Promise<ContainerState | null> {
		// Find an available container
		const containers = this.ctx.storage.sql
			.exec<ContainerState>(`SELECT * FROM containers WHERE session_id IS NULL AND health = 'true' LIMIT 1`)
			.toArray();

		console.log('container', containers.length);
		console.log('sessionId', sessionId);

		let containerData: ContainerState;

		if (containers.length === 0) {
			// No available containers, create a new one
			console.log('creating new container');
			try {
				containerData = await this.createContainer();
			} catch (e) {
				console.error('Error creating container', e);
				return null;
			}
		} else {
			containerData = containers[0];
		}

		console.log('containerData', containerData);

		// Update container with session
		const result = await this.ctx.storage.sql.exec(
			`UPDATE containers SET session_id = ?, last_activity = ? WHERE id = ?`,
			...[sessionId, Date.now(), containerData.id]
		);

		const newContainer = await this.ctx.storage.sql
			.exec<ContainerState>(`SELECT * FROM containers WHERE id = ?`, ...[containerData.id])
			.one();

		// Log event
		await this.logEvent({
			type: 'container_allocated',
			containerId: containerData.id,
			timestamp: Date.now(),
			details: JSON.stringify({ sessionId }),
		});

		// Maintain pool size
		this.maintainPool();

		return newContainer;
	}

	async deallocateContainer(containerId: string): Promise<void> {
		const containerCursor = await this.ctx.storage.sql.exec(`SELECT * FROM containers WHERE id = ?`, ...[containerId]);
		const container = await containerCursor.next();

		if (container.done) {
			throw new Error('Container not found');
		}

		const containerData = container.value as unknown as ContainerState;

		await this.ctx.storage.sql.exec(
			`UPDATE containers SET session_id = NULL, last_activity = ? WHERE id = ?`,
			...[Date.now(), containerId]
		);

		await this.logEvent({
			type: 'container_deallocated',
			containerId,
			timestamp: Date.now(),
			details: JSON.stringify({ previousSessionId: containerData.sessionId }),
		});

		// Maintain pool size
		await this.maintainPool();
	}

	private async resetContainers(): Promise<void> {
		// Delete all containers
		await this.ctx.storage.sql.exec(`DELETE FROM containers`);
		await this.ctx.storage.sql.exec(`UPDATE pool_config SET value = 0 WHERE key = 'current_size'`);
		// Log the reset event
		await this.logEvent({
			type: 'pool_size_changed',
			containerId: 'system',
			timestamp: Date.now(),
			details: JSON.stringify({ action: 'reset', message: 'All containers have been reset' }),
		});

		// Reinitialize the pool with minimum containers
		await this.initializePool();
	}

	async getStatus(): Promise<{
		containers: ContainerState[];
		poolConfig: { minSize: number; maxSize: number; currentSize: number };
	}> {
		const containers = this.ctx.storage.sql.exec<ContainerState>(`SELECT * FROM containers`).toArray();

		console.log('# containers: ', containers.length);

		const poolConfig: Record<string, number> = {};
		const poolConfigCursor = this.ctx.storage.sql.exec(`SELECT * FROM pool_config`).toArray();
		for await (const row of poolConfigCursor) {
			const key = row.key as string;
			const value = row.value as number;
			poolConfig[key] = value;
		}

		return {
			containers,
			poolConfig: {
				minSize: poolConfig['min_size'] ?? 2,
				maxSize: poolConfig['max_size'] ?? 10,
				currentSize: poolConfig['current_size'] ?? 0,
			},
		};
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			const data = JSON.parse(message as string);
			if (data.type === 'subscribe') {
				// Send current status
				const status = await this.getStatus();
				ws.send(JSON.stringify({ type: 'status', data: status }));
			}
		} catch (e) {
			console.error('Error parsing message', e);
			// Handle invalid messages
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		// Clean up if needed
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === '/status') {
			const status = await this.getStatus();
			return new Response(JSON.stringify(status), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (path === '/allocate' && request.method === 'POST') {
			console.log('allocate');
			const body = (await request.json()) as { sessionId: string };
			const container = await this.allocateContainer(body.sessionId);
			console.log('container', container);
			if (!container) {
				return new Response(JSON.stringify({ error: 'No available containers' }), {
					headers: { 'Content-Type': 'application/json' },
					status: 507,
				});
			}
			return new Response(JSON.stringify(container), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (path.startsWith('/deallocate/')) {
			const containerId = path.split('/')[2];
			await this.deallocateContainer(containerId);
			return new Response(null, { status: 204 });
		}

		if (path === '/reset' && request.method === 'POST') {
			await this.resetContainers();
			return new Response(null, { status: 204 });
		}

		if (path === '/ws') {
			const webSocketPair = new WebSocketPair();
			const [client, server] = Object.values(webSocketPair);

			// Accept the WebSocket connection and enable hibernation
			this.ctx.acceptWebSocket(server);

			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		}

		return new Response('Not found', { status: 404 });
	}
}

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Add CORS headers
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle preflight requests
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders,
			});
		}

		const id = env.CONTAINER_ORCHESTRATOR.idFromName('main');
		const stub = env.CONTAINER_ORCHESTRATOR.get(id);
		const response = await stub.fetch(request);

		if (request.url.includes('/ws')) {
			return response;
		}

		// Add CORS headers to the response
		const newHeaders = new Headers(response.headers);
		Object.entries(corsHeaders).forEach(([key, value]) => {
			newHeaders.set(key, value);
		});

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: newHeaders,
		});
	},
} satisfies ExportedHandler<Env>;

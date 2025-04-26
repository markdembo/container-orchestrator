import { DurableObject } from 'cloudflare:workers';

interface ContainerState {
	id: string;
	sessionId: string | null;
	ipv6Address: string;
	health: boolean;
	createdAt: number;
	lastActivity: number;
}

type EventType = 'container_created' | 'container_allocated' | 'container_deallocated' | 'container_health_changed' | 'pool_size_changed';

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

	private async broadcastEvent(event: Event) {
		const message = JSON.stringify(event);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(message);
			} catch (e) {
				// Handle failed sends
			}
		}
	}

	private async logEvent(event: Event) {
		await this.ctx.storage.sql.exec(`INSERT INTO events (type, container_id, timestamp, details) VALUES (?, ?, ?, ?)`, [
			event.type,
			event.containerId,
			event.timestamp,
			event.details,
		]);
		await this.broadcastEvent(event);
	}

	async allocateContainer(sessionId: string): Promise<ContainerState> {
		// Find an available container
		const containerCursor = await this.ctx.storage.sql.exec(`SELECT * FROM containers WHERE session_id IS NULL AND health = true LIMIT 1`);
		const container = await containerCursor.next();

		if (container.done) {
			throw new Error('No available containers');
		}

		const containerData = container.value as unknown as ContainerState;

		// Update container with session
		await this.ctx.storage.sql.exec(`UPDATE containers SET session_id = ?, last_activity = ? WHERE id = ?`, [
			sessionId,
			Date.now(),
			containerData.id,
		]);

		// Log event
		await this.logEvent({
			type: 'container_allocated',
			containerId: containerData.id,
			timestamp: Date.now(),
			details: JSON.stringify({ sessionId }),
		});

		return containerData;
	}

	async deallocateContainer(containerId: string): Promise<void> {
		const containerCursor = await this.ctx.storage.sql.exec(`SELECT * FROM containers WHERE id = ?`, [containerId]);
		const container = await containerCursor.next();

		if (container.done) {
			throw new Error('Container not found');
		}

		const containerData = container.value as unknown as ContainerState;

		await this.ctx.storage.sql.exec(`UPDATE containers SET session_id = NULL, last_activity = ? WHERE id = ?`, [Date.now(), containerId]);

		await this.logEvent({
			type: 'container_deallocated',
			containerId,
			timestamp: Date.now(),
			details: JSON.stringify({ previousSessionId: containerData.sessionId }),
		});
	}

	async getStatus(): Promise<{
		containers: ContainerState[];
		poolConfig: { minSize: number; maxSize: number; currentSize: number };
	}> {
		const containers: ContainerState[] = [];
		const containersCursor = await this.ctx.storage.sql.exec(`SELECT * FROM containers`);
		for await (const row of containersCursor) {
			containers.push(row as unknown as ContainerState);
		}

		const poolConfig: Record<string, number> = {};
		const poolConfigCursor = await this.ctx.storage.sql.exec(`SELECT * FROM pool_config`);
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

		if (path === '/allocate') {
			const body = (await request.json()) as { sessionId: string };
			const container = await this.allocateContainer(body.sessionId);
			return new Response(JSON.stringify(container), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (path.startsWith('/deallocate/')) {
			const containerId = path.split('/')[2];
			await this.deallocateContainer(containerId);
			return new Response(null, { status: 204 });
		}

		if (path === '/ws') {
			const { 0: client, 1: server } = new WebSocketPair();

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
		const id = env.CONTAINER_ORCHESTRATOR.idFromName('main');
		const stub = env.CONTAINER_ORCHESTRATOR.get(id);
		return stub.fetch(request);
	},
} satisfies ExportedHandler<Env>;

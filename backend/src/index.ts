import { Container } from 'cf-containers';
import { DurableObject, env } from 'cloudflare:workers';

interface ContainerState extends Record<string, SqlStorageValue> {
	id: string;
	projectId: string | null;
	createdAt: number;
	lastActivity: number;
}

type EventType = 'container_created' | 'container_allocated' | 'container_deallocated' | 'container_shutdown' | 'pool_size_changed';

interface Event {
	type: EventType;
	containerId: string;
	timestamp: number;
	details: string;
}

export class LovContainer extends Container {
	// Configure default port for the container
	defaultPort = 5000;
	sleepAfter = '5m';

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	onStop(): void | Promise<void> {

		// This is called when the container is stopped
		// You can add any cleanup logic here
		console.log('Container stopped yo');
	}

	async fetch(request: Request): Promise<Response> {
		if (request.url.endsWith('/kill')) {
			this.stopContainer('Pool management');
			return new Response('Killed', { status: 200 });
		}
		if (request.url.endsWith('/start')) {
			this.startAndWaitForPorts([5000]);
			return new Response('Started', { status: 200 });
		}
		// Default implementation proxies requests to the container
		return await this.containerFetch(request);
	}
}

interface Env {
	CONTAINER_ORCHESTRATOR: DurableObjectNamespace<ContainerOrchestrator>;
	//@ts-expect-error type error
	LOVING_CONTAINER: DurableObjectNamespace<LovContainer>;
}

export class ContainerOrchestrator extends DurableObject {
	protected env: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.initializeSchema();
		this.initializePool();
		this.env = env;
	}

	private async initializeSchema() {
		await this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS containers (
				id TEXT PRIMARY KEY,
				project_id TEXT,
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
				('current_size', 0),
				('buffer_size', 2);
		`);
	}

	private async initializePool() {
		// Check if we need to create initial containers
		const bufferSize = await this.ctx.storage.sql.exec<{ value: number }>(`SELECT value FROM pool_config WHERE key = 'buffer_size'`).one()
			.value;

		const idleCount = await this.ctx.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) as count FROM containers WHERE project_id IS NULL`)
			.one().count;

		if (idleCount < bufferSize) {
			// Create containers to reach minimum pool size
			const toCreate = bufferSize - idleCount;
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

		const containerId = this.env.LOVING_CONTAINER.newUniqueId();
		const stub = this.env.LOVING_CONTAINER.get(containerId);
		// dummy request to wake up the container
		const response = await stub.fetch(new Request('http://localhost/start'));
		console.log('response', response);
		const now = Date.now();

		await this.ctx.storage.sql.exec(
			`INSERT INTO containers (id, project_id, created_at, last_activity) 
			 VALUES (?, ?, ?, ?)`,
			...[containerId.toString(), null, now, now]
		);

		await this.ctx.storage.sql.exec(`UPDATE pool_config SET value = value + 1 WHERE key = 'current_size'`);

		await this.logEvent({
			type: 'container_created',
			containerId: containerId.toString(),
			timestamp: now,
			details: JSON.stringify({}),
		});

		return {
			id: containerId.toString(),
			projectId: null,
			createdAt: now,
			lastActivity: now,
		};
	}

	private async shutdownExcessContainers() {
		const bufferSize = await this.ctx.storage.sql.exec<{ value: number }>(`SELECT value FROM pool_config WHERE key = 'buffer_size'`).one()
			.value;

		const idleContainers = await this.ctx.storage.sql
			.exec<{ id: string }>(`SELECT id FROM containers WHERE project_id IS NULL ORDER BY created_at ASC`)
			.toArray();

		if (idleContainers.length > bufferSize) {
			const excessCount = idleContainers.length - bufferSize;
			const containersToShutdown = idleContainers.slice(0, excessCount);

			for (const container of containersToShutdown) {
				const id = this.env.LOVING_CONTAINER.idFromName(container.id);
				const stub = this.env.LOVING_CONTAINER.get(id);
				// dummy request to kill the container
				const response = await stub.fetch(new Request('http://localhost/kill'));
				console.log('response', response.status);

				await this.ctx.storage.sql.exec(`DELETE FROM containers WHERE id = ?`, container.id);

				await this.logEvent({
					type: 'container_shutdown',
					containerId: container.id,
					timestamp: Date.now(),
					details: JSON.stringify({ reason: 'excess_idle_container' }),
				});
			}

			await this.ctx.storage.sql.exec(`UPDATE pool_config SET value = value - ? WHERE key = 'current_size'`, excessCount);
		}
	}

	private async maintainPool() {
		const bufferSize = await this.ctx.storage.sql.exec<{ value: number }>(`SELECT value FROM pool_config WHERE key = 'buffer_size'`).one()
			.value;

		const idleContainers = await this.ctx.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) as count FROM containers WHERE project_id IS NULL`)
			.one().count;

		if (idleContainers < bufferSize) {
			// Create containers to maintain minimum buffer size
			const toCreate = bufferSize - idleContainers;
			for (let i = 0; i < toCreate; i++) {
				try {
					await this.createContainer();
				} catch (e) {
					console.error('Error creating container', e);
				}
			}
		} else if (idleContainers > bufferSize) {
			// Shutdown excess containers
			await this.shutdownExcessContainers();
		}
	}

	private async logEvent(event: Event) {
		await this.ctx.storage.sql.exec(
			`INSERT INTO events (type, container_id, timestamp, details) VALUES (?, ?, ?, ?)`,
			...[event.type, event.containerId, event.timestamp, event.details]
		);
	}

	async allocateContainer(projectId: string): Promise<ContainerState | null> {
		// First check if a container for this project already exists
		let existingContainer: ContainerState | null = null;
		try {
			existingContainer = await this.ctx.storage.sql
			.exec<ContainerState>(`SELECT * FROM containers WHERE project_id = ? LIMIT 1`, ...[projectId])
			.one();
		} catch (error) {
			console.error('Error fetching existing container', error);
		}


		if (existingContainer) {
			return existingContainer;
		}

		// Find an available container
		const containers = await this.ctx.storage.sql
			.exec<ContainerState>(`SELECT * FROM containers WHERE project_id IS NULL LIMIT 1`)
			.toArray();

		console.log('available containers:', containers.length);
		console.log('projectId:', projectId);

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

		console.log('containerData:', containerData);

		// Update container with project
		await this.ctx.storage.sql.exec(
			`UPDATE containers SET project_id = ?, last_activity = ? WHERE id = ?`,
			...[projectId, Date.now(), containerData.id]
		);

		const newContainer = await this.ctx.storage.sql
			.exec<ContainerState>(`SELECT * FROM containers WHERE id = ?`, ...[containerData.id])
			.one();

		// Log event
		await this.logEvent({
			type: 'container_allocated',
			containerId: containerData.id,
			timestamp: Date.now(),
			details: JSON.stringify({ projectId }),
		});

		// Maintain pool size
		this.maintainPool();

		return newContainer;
	}

	private async resetContainers(): Promise<void> {
		// Delete all containers
		// Get all containers, iterate over them and call kill them
		const containers = await this.ctx.storage.sql.exec<ContainerState>(`SELECT * FROM containers`).toArray();
		for (const container of containers) {
			const id = this.env.LOVING_CONTAINER.idFromName(container.id);
			const stub = this.env.LOVING_CONTAINER.get(id);
			const response = await stub.fetch(new Request('http://localhost/kill'));
			console.log('response', response.status);
		}
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
		poolConfig: { minSize: number; maxSize: number; currentSize: number; bufferSize: number };
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
				bufferSize: poolConfig['buffer_size'] ?? 2,
			},
		};
	}

	async getLogs(): Promise<string> {
		const logs = await this.ctx.storage.sql.exec(`SELECT * FROM events`).toArray();
		return logs.map((log) => JSON.stringify(log)).join('\n');
	}

	async getContainerIdByProjectId(projectId: string): Promise<string | null> {
		const container = await this.ctx.storage.sql
			.exec<ContainerState>(`SELECT * FROM containers WHERE project_id = ? LIMIT 1`, ...[projectId])
			.one();
		return container?.id ?? null;
	}

	private async updatePoolConfig(config: { minSize?: number; maxSize?: number; bufferSize?: number }): Promise<void> {
		const updates = [];
		const params = [];

		if (config.minSize !== undefined) {
			updates.push("UPDATE pool_config SET value = ? WHERE key = 'min_size'");
			params.push(config.minSize);
		}

		if (config.maxSize !== undefined) {
			updates.push("UPDATE pool_config SET value = ? WHERE key = 'max_size'");
			params.push(config.maxSize);
		}

		if (config.bufferSize !== undefined) {
			// Add or update buffer_size in pool_config
			await this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO pool_config (key, value) VALUES ('buffer_size', ?)`, config.bufferSize);
		}

		// Execute all updates
		for (let i = 0; i < updates.length; i++) {
			await this.ctx.storage.sql.exec(updates[i], params[i]);
		}

		// Log the configuration change
		await this.logEvent({
			type: 'pool_size_changed',
			containerId: 'system',
			timestamp: Date.now(),
			details: JSON.stringify({
				action: 'config_updated',
				changes: config,
			}),
		});

		// Maintain pool based on new configuration
		await this.maintainPool();
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

		if (path === '/logs') {
			const logs = await this.getLogs();
			return new Response(JSON.stringify(logs), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (path === '/allocate' && request.method === 'POST') {
			console.log('allocate');
			const body = (await request.json()) as { projectId: string };
			const container = await this.allocateContainer(body.projectId);
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

		if (path === '/reset') {
			await this.resetContainers();
			return new Response(null, { status: 204 });
		}

		if (path === '/config' && request.method === 'PUT') {
			try {
				const body = (await request.json()) as { minSize?: number; maxSize?: number; bufferSize?: number };
				await this.updatePoolConfig(body);
				const status = await this.getStatus();
				return new Response(JSON.stringify(status), {
					headers: { 'Content-Type': 'application/json' },
				});
			} catch (error) {
				return new Response(JSON.stringify({ error: 'Invalid configuration' }), {
					headers: { 'Content-Type': 'application/json' },
					status: 400,
				});
			}
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

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// The url looks like this: {projectId}.not-a-single-bug.com
		// We need to extract the projectId from the url
		const url = new URL(request.url);
		const projectId = url.hostname.split('.')[0];

		// Then we need to forward the request to the container orchestrator
		// This part can be cached in the future
		const id = env.CONTAINER_ORCHESTRATOR.idFromName('main');
		const stub = env.CONTAINER_ORCHESTRATOR.get(id);
		const containerId = await stub.getContainerIdByProjectId(projectId);

		if (!containerId) {
			return new Response('No container found for project', { status: 404 });
		}

		// Let's block all requests to private paths /kill and /start
		if (request.url.endsWith('/kill') || request.url.endsWith('/start')) {
			return new Response('Not allowed', { status: 403 });
		}

		const container = env.LOVING_CONTAINER.idFromName(containerId);
		const containerStub = env.LOVING_CONTAINER.get(container);
		const response = await containerStub.fetch(request);

		return response;
	},
} satisfies ExportedHandler<Env>;

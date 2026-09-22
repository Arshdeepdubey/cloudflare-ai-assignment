import { ChatSession } from "./chat-session";

export { ChatSession };

export interface Env {
	AI: Ai;
	CHAT_SESSION: DurableObjectNamespace;
}

// Basic CORS so the Pages-hosted UI (a different origin in local dev) can call this Worker.
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, { headers: CORS_HEADERS });
		}

		// POST /api/chat  { sessionId: string, message: string }
		if (url.pathname === "/api/chat" && request.method === "POST") {
			const { sessionId, message } = await request.json<{
				sessionId?: string;
				message?: string;
			}>();

			if (!sessionId || !message) {
				return jsonResponse({ error: "sessionId and message are required" }, 400);
			}

			// Route to the Durable Object instance that owns this conversation.
			// idFromName() means the same sessionId always maps to the same instance,
			// which is what gives us persistent per-conversation memory.
			const id = env.CHAT_SESSION.idFromName(sessionId);
			const stub = env.CHAT_SESSION.get(id);

			const reply = await stub.fetch("https://internal/chat", {
				method: "POST",
				body: JSON.stringify({ message }),
				headers: { "Content-Type": "application/json" },
			});

			const data = await reply.json();
			return jsonResponse(data, reply.status);
		}

		// GET /api/history?sessionId=...
		if (url.pathname === "/api/history" && request.method === "GET") {
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) {
				return jsonResponse({ error: "sessionId is required" }, 400);
			}

			const id = env.CHAT_SESSION.idFromName(sessionId);
			const stub = env.CHAT_SESSION.get(id);

			const reply = await stub.fetch("https://internal/history");
			const data = await reply.json();
			return jsonResponse(data, reply.status);
		}

		return jsonResponse({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<Env>;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

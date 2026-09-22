import type { Env } from "./index";

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

const SYSTEM_PROMPT =
	"You are a concise, helpful assistant. Keep answers clear and to the point.";

// How many prior turns to keep as context for the model.
const MAX_HISTORY = 10;

/**
 * ChatSession — one Durable Object instance per conversation.
 *
 * This class is the "workflow/coordination" layer for the assignment:
 * every request runs the same sequence — load memory, call the LLM,
 * persist the result — as a single, ordered unit of work owned by
 * this instance.
 *
 * It is also the "memory/state" layer: each instance has its own
 * private SQLite database (via `ctx.storage.sql`), so conversation
 * history survives across requests, deploys, and page reloads,
 * as long as the same sessionId is used.
 */
export class ChatSession {
	private ctx: DurableObjectState;
	private env: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		this.env = env;
		this.ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					role TEXT NOT NULL,
					content TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`);
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/chat" && request.method === "POST") {
			return this.handleChat(request);
		}

		if (url.pathname === "/history" && request.method === "GET") {
			return this.handleHistory();
		}

		return new Response("Not found", { status: 404 });
	}

	private async handleChat(request: Request): Promise<Response> {
		const { message } = await request.json<{ message: string }>();

		// Step 1 — load memory
		const history = this.loadHistory();

		// Step 2 — save the incoming user message
		this.saveMessage("user", message);

		// Step 3 — call the LLM with system prompt + trimmed history + new message
		const messages: ChatMessage[] = [
			{ role: "system", content: SYSTEM_PROMPT },
			...history,
			{ role: "user", content: message },
		];

		const aiResponse = await this.env.AI.run(
			"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			{ messages }
		);

		const replyText =
			(aiResponse as { response?: string }).response ??
			"Sorry, I couldn't generate a response.";

		// Step 4 — persist the assistant's reply
		this.saveMessage("assistant", replyText);

		// Step 5 — return the reply
		return new Response(JSON.stringify({ reply: replyText }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	private async handleHistory(): Promise<Response> {
		const history = this.loadHistory();
		return new Response(JSON.stringify({ history }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	private loadHistory(): ChatMessage[] {
		const rows = this.ctx.storage.sql
			.exec(
				`SELECT role, content FROM messages ORDER BY id DESC LIMIT ?`,
				MAX_HISTORY
			)
			.toArray();

		// rows come back newest-first; reverse to chronological order
		return rows.reverse().map((row) => ({
			role: row.role as ChatMessage["role"],
			content: row.content as string,
		}));
	}

	private saveMessage(role: ChatMessage["role"], content: string): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)`,
			role,
			content,
			Date.now()
		);
	}
}

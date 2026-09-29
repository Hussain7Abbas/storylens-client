import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/config";
import { discoverCatalog } from "../src/providers/catalog";
import {
	type executeProvider,
	parseClaudeOutput,
	parseCodexOutput,
} from "../src/providers/execute";
import {
	imageMimeType,
	parseCodexImageEvents,
	resolveGeneratedImage,
} from "../src/providers/image";
import { createServer } from "../src/server";
import { PromptService } from "../src/service";
import type { ModelOption } from "../src/types";

const model: ModelOption = {
	id: "codex:gpt-6-sol",
	provider: "codex",
	providerModel: "gpt-6-sol",
	label: "Sol",
	efforts: ["low", "medium"],
	defaultEffort: "medium",
	aliases: ["codex-sol6"],
};
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

async function fixture(
	execute: typeof executeProvider = async () => "A plain text result",
) {
	const dir = await mkdtemp(join(tmpdir(), "storylens-test-"));
	dirs.push(dir);
	const settings = new SettingsStore(join(dir, "settings.json"));
	await settings.load();
	const service = new PromptService(settings, execute, async () => ({
		models: [model],
		providers: [
			{ provider: "codex", available: true },
			{ provider: "claude", available: false },
		],
	}));
	await service.refresh();
	const server = createServer(settings, service);
	const headers = {
		host: `127.0.0.1:${settings.get().port}`,
		authorization: `Bearer ${settings.get().token}`,
	};
	return { server, headers, settings, service };
}

describe("ExecutePrompt boundary", () => {
	test("rejects missing credentials and website origins before running a provider", async () => {
		let calls = 0;
		const { server, headers } = await fixture(async () => {
			calls++;
			return "ok";
		});
		const body = {
			prompt: "hello",
			model: model.id,
			effort: "low",
			responseLanguage: "en",
		};
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/ExecutePrompt",
					headers: { host: headers.host },
					payload: body,
				})
			).statusCode,
		).toBe(401);
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/ExecutePrompt",
					headers: { ...headers, origin: "https://evil.example" },
					payload: body,
				})
			).statusCode,
		).toBe(403);
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/ExecutePrompt",
					headers: { ...headers, host: "attacker.example" },
					payload: body,
				})
			).statusCode,
		).toBe(403);
		expect(calls).toBe(0);
		await server.close();
	});
	test("lets the dashboard origin connect with the pairing token only", async () => {
		const { server, headers } = await fixture(async () => "ok");
		const origin = "https://storylens-dashboard.iscoded.com";
		const preflight = await server.inject({
			method: "OPTIONS",
			url: "/capabilities",
			headers: {
				host: headers.host,
				origin,
				"access-control-request-private-network": "true",
			},
		});
		expect(preflight.statusCode).toBe(204);
		expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
		expect(preflight.headers["access-control-allow-private-network"]).toBe(
			"true",
		);
		expect(
			(
				await server.inject({
					method: "GET",
					url: "/capabilities",
					headers: { host: headers.host, origin },
				})
			).statusCode,
		).toBe(401);
		expect(
			(
				await server.inject({
					method: "GET",
					url: "/capabilities",
					headers: { ...headers, origin },
				})
			).statusCode,
		).toBe(200);
		await server.close();
	});
	test("validates dynamic model effort and returns final text", async () => {
		const { server, headers } = await fixture();
		const unknown = await server.inject({
			method: "POST",
			url: "/ExecutePrompt",
			headers,
			payload: {
				prompt: "hello",
				model: model.id,
				effort: "max",
				responseLanguage: "en",
			},
		});
		expect(unknown.statusCode).toBe(422);
		const valid = await server.inject({
			method: "POST",
			url: "/ExecutePrompt",
			headers,
			payload: {
				prompt: "hello",
				model: "codex-sol6",
				effort: "low",
				responseLanguage: "ar",
			},
		});
		expect(valid.statusCode).toBe(200);
		expect(valid.json().output).toBe("A plain text result");
		expect(valid.json().model).toBe(model.id);
		expect(valid.json().responseLanguage).toBe("ar");
		const caps = await server.inject({
			method: "GET",
			url: "/capabilities",
			headers,
		});
		expect(caps.json().models[0].efforts).toEqual(["low", "medium"]);
		await server.close();
	});
	test("limits concurrent provider work", async () => {
		const releases: (() => void)[] = [];
		const { service, server } = await fixture(
			() =>
				new Promise<string>((resolve) => {
					releases.push(() => resolve("done"));
				}),
		);
		const input = {
			prompt: "hello",
			model: model.id,
			effort: "low",
			responseLanguage: "en",
		};
		const first = service.executePrompt(input);
		const second = service.executePrompt(input);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(service.activeCount()).toBe(2);
		await expect(service.executePrompt(input)).rejects.toMatchObject({
			code: "BUSY",
		});
		releases.forEach((release) => release());
		await Promise.all([first, second]);
		expect(service.activeCount()).toBe(0);
		await server.close();
	});
	test("streams a terminal result and cancels running work on shutdown", async () => {
		const { server, headers } = await fixture();
		const streamed = await server.inject({
			method: "POST",
			url: "/ExecutePrompt",
			headers: { ...headers, accept: "application/x-ndjson" },
			payload: {
				prompt: "hello",
				model: model.id,
				effort: "low",
				responseLanguage: "en",
			},
		});
		expect(streamed.statusCode).toBe(200);
		expect(
			streamed.body
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).type),
		).toEqual(["started", "result"]);
		await server.close();

		let canceled = false;
		const second = await fixture(
			(_settings, _model, _effort, _prompt, _responseLanguage, signal) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							canceled = true;
							reject(new Error("canceled"));
						},
						{ once: true },
					);
				}),
		);
		const pending = second.service
			.executePrompt({
				prompt: "hello",
				model: model.id,
				effort: "low",
				responseLanguage: "en",
			})
			.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 10));
		second.service.cancelAll();
		await pending;
		expect(canceled).toBe(true);
		expect(second.service.activeCount()).toBe(0);
		await second.server.close();
	});
});

test("response language is required and reaches the provider", async () => {
	let received = "";
	const { server, headers } = await fixture(
		async (_settings, _model, _effort, _prompt, responseLanguage) => {
			received = responseLanguage;
			return "تم";
		},
	);
	const missing = await server.inject({
		method: "POST",
		url: "/ExecutePrompt",
		headers,
		payload: { prompt: "hello", model: model.id, effort: "low" },
	});
	expect(missing.statusCode).toBe(400);
	const invalid = await server.inject({
		method: "POST",
		url: "/ExecutePrompt",
		headers,
		payload: {
			prompt: "hello",
			model: model.id,
			effort: "low",
			responseLanguage: "fr",
		},
	});
	expect(invalid.statusCode).toBe(400);
	const valid = await server.inject({
		method: "POST",
		url: "/ExecutePrompt",
		headers,
		payload: {
			prompt: "hello",
			model: model.id,
			effort: "low",
			responseLanguage: "ar",
		},
	});
	expect(valid.statusCode).toBe(200);
	expect(received).toBe("ar");
	expect(valid.json().responseLanguage).toBe("ar");
	await server.close();
});

test("provider parsers return final messages, not progress or tool text", () => {
	expect(
		parseClaudeOutput(
			'{"type":"system"}\n{"type":"result","is_error":false,"result":"OK"}\n',
		),
	).toBe("OK");
	expect(
		parseCodexOutput(
			'{"type":"item.completed","item":{"type":"command_execution","text":"private"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n',
		),
	).toBe("OK");
});

if (process.platform !== "win32")
	test("Codex catalog starts with a GUI-style PATH and waits for initialization", async () => {
		const dir = await mkdtemp(join(tmpdir(), "storylens-catalog-test-"));
		dirs.push(dir);
		const codex = join(dir, "codex");
		await writeFile(codex, "#!/usr/bin/env storylens-catalog-runtime\n", {
			mode: 0o755,
		});
		await writeFile(
			join(dir, "storylens-catalog-runtime"),
			[
				"#!/bin/sh",
				"IFS= read -r initialize",
				'printf \'%s\\n\' \'{"id":1,"result":{"userAgent":"test"}}\'',
				"IFS= read -r initialized",
				"IFS= read -r model_list",
				'printf \'%s\\n\' \'{"id":2,"result":{"data":[{"id":"gpt-test","model":"gpt-test","inputModalities":["text"],"supportedReasoningEfforts":[{"reasoningEffort":"low"}]}],"nextCursor":null}}\'',
			].join("\n"),
			{ mode: 0o755 },
		);
		const originalPath = process.env.PATH;
		process.env.PATH = "/usr/bin:/bin";
		try {
			const result = await discoverCatalog({
				port: 43127,
				token: "test",
				claudePath: "/missing-claude",
				codexPath: codex,
				extraModels: [],
			});
			expect(
				result.providers.find((provider) => provider.provider === "codex")
					?.available,
			).toBe(true);
			expect(
				result.models.find((item) => item.id === "codex:gpt-test")?.efforts,
			).toEqual(["low"]);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});

const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(200, 1),
]);

test("image events yield inline results or saved paths, never other items", async () => {
	const inline = parseCodexImageEvents(
		`{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"item.completed","item":{"type":"image_generation","result":"${png.toString("base64")}","revised_prompt":"A portrait"}}\n`,
	);
	expect(inline.revisedPrompt).toBe("A portrait");
	expect(
		imageMimeType(await resolveGeneratedImage(inline, [], Date.now())),
	).toBe("image/png");

	const dir = await mkdtemp(join(tmpdir(), "storylens-image-test-"));
	dirs.push(dir);
	const saved = join(dir, "thread", "image.png");
	await mkdir(join(dir, "thread"));
	await writeFile(saved, png);
	const byPath = parseCodexImageEvents(
		`{"type":"item.completed","item":{"type":"imageGeneration","savedPath":${JSON.stringify(saved)}}}\n`,
	);
	expect(
		(await resolveGeneratedImage(byPath, [dir], Date.now() + 60_000)).equals(
			png,
		),
	).toBe(true);
	const outside = parseCodexImageEvents(
		`{"type":"item.completed","item":{"type":"image_generation","saved_path":"/etc/passwd.png"}}\n`,
	);
	await expect(
		resolveGeneratedImage(outside, [join(dir, "missing")], Date.now()),
	).rejects.toMatchObject({ code: "PROVIDER_RESULT" });
	expect(
		(await resolveGeneratedImage({ paths: [] }, [dir], 0)).equals(png),
	).toBe(true);
});

test("GenerateImage falls back to a Codex model and passes web search only when asked", async () => {
	const claude: ModelOption = {
		...model,
		id: "claude:sonnet",
		provider: "claude",
		providerModel: "sonnet",
		aliases: [],
	};
	const dir = await mkdtemp(join(tmpdir(), "storylens-test-"));
	dirs.push(dir);
	const settings = new SettingsStore(join(dir, "settings.json"));
	await settings.load();
	let webSearch: boolean | undefined;
	let imageModel = "",
		imageEffort = "";
	const service = new PromptService(
		settings,
		async (_s, _m, _e, _p, _l, _signal, options) => {
			webSearch = options?.webSearch;
			return "ok";
		},
		async () => ({ models: [claude, model], providers: [] }),
		async (_s, chosen, effort) => {
			imageModel = chosen.id;
			imageEffort = effort;
			return { mimeType: "image/png", data: png.toString("base64") };
		},
	);
	const server = createServer(settings, service);
	const headers = {
		host: `127.0.0.1:${settings.get().port}`,
		authorization: `Bearer ${settings.get().token}`,
	};
	expect(
		(
			await server.inject({ method: "GET", url: "/capabilities", headers })
		).json().features,
	).toEqual({ webSearch: true, imageGeneration: true });
	await server.inject({
		method: "POST",
		url: "/ExecutePrompt",
		headers,
		payload: {
			prompt: "hi",
			model: claude.id,
			effort: "low",
			responseLanguage: "en",
			webSearch: true,
		},
	});
	expect(webSearch).toBe(true);
	const image = await server.inject({
		method: "POST",
		url: "/GenerateImage",
		headers: { ...headers, accept: "application/x-ndjson" },
		payload: { prompt: "A knight", model: claude.id, effort: "high" },
	});
	const frames = image.body
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(frames.map((frame) => frame.type)).toEqual(["started", "result"]);
	expect(frames[1].mimeType).toBe("image/png");
	expect(imageModel).toBe(model.id);
	expect(imageEffort).toBe(model.defaultEffort);
	expect(
		(
			await server.inject({
				method: "POST",
				url: "/GenerateImage",
				headers,
				payload: { prompt: "", model: model.id, effort: "low" },
			})
		).statusCode,
	).toBe(400);
	await server.close();
});

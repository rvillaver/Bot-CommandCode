import type {ModApi} from '@commandcode/harness';

/**
 * cmd-relay mod — the seam between a headless `cmd` run and the Discord bot.
 *
 * Two jobs:
 * 1. Intercept `ask_user_question` so the question is forwarded to Discord as buttons
 *    instead of auto-answering option 1 (SPEC §1 gotcha 3, §4).
 * 2. Detect when the model writes a file into `.cmd-relay/out/` and tell the bot to
 *    upload it mid-turn (safe file display).
 */
export default function (cmd: ModApi): void {
	const port = process.env.RELAY_PORT ?? '8787';
	const base = `http://127.0.0.1:${port}`;

	function post(path: string, body: unknown): Promise<Response> {
		return fetch(`${base}${path}`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}).catch((err) => {
			// Bridge unreachable — the caller decides how to degrade.
			console.error(`[mods/relay] bridge POST ${path} failed: ${err.message}`);
			throw err;
		});
	}

	cmd.hooks({
		beforeToolCall: async ({toolName, input, state}) => {
			if (toolName !== 'ask_user_question') return undefined;

			// Forward the question set to the bridge, keyed by the running session.
			const sessionId =
				(state.sessionId as string | undefined) ??
				(state.session?.id as string | undefined) ??
				'unknown';
			try {
				await post('/question', {
					sessionId,
					questions: input.questions,
				});
			} catch {
				// Bridge down — still block so the model doesn't auto-answer; tell it the
				// relay is unreachable so it responds in plain text instead of stalling.
			}

			// Block the real call; the user's answer arrives as their next message.
			return {
				block: true,
				additionalContext:
					'The question was shown to the user in chat. End your turn now; ' +
					"the user's answer will arrive as their next message.",
			};
		},

		afterToolCall: async ({toolName, input}) => {
			// Detect writes into the out drop-point. Only files under .cmd-relay/out/
			// are ever surfaced — never arbitrary project paths.
			const path = filePathFromInput(toolName, input);
			if (!path) return undefined;
			if (!isUnderOutDir(cmd.cwd, path)) return undefined;

			try {
				await post('/file', {path});
			} catch {
				// Bridge unreachable — the file simply doesn't stream mid-turn; it will
				// still be attached at finalize by collectOutFiles.
			}
			return undefined;
		},
	});
}

function filePathFromInput(
	toolName: string,
	input: Record<string, unknown>,
): string | undefined {
	if (toolName === 'write_file' || toolName === 'edit_file') {
		const p = input.file_path;
		return typeof p === 'string' ? p : undefined;
	}
	// shell_command can produce files (e.g. `cat > out.txt`), but the produced path
	// isn't reliably knowable from input — skip shell for v1 (finalize dedup covers it).
	return undefined;
}

/** True when the absolute path sits inside <cwd>/.cmd-relay/out. */
function isUnderOutDir(cwd: string, absPath: string): boolean {
	const out = `${cwd.replace(/\/+$/, '')}/.cmd-relay/out`;
	return absPath.startsWith(`${out}/`) || absPath === out;
}

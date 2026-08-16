import { describe, expect, it } from "vitest";
import { getRetryAfterMs, isPdsRateLimitError, PdsRateLimiter } from "../../scripts/pds-rate-limit.js";

function rateLimitError(retryAfter: string): { status: number; headers: Record<string, string> } {
	return { status: 429, headers: { "retry-after": retryAfter } };
}

describe("PdsRateLimiter", () => {
	it("preserves zero retry-after values and prefers retry-after", () => {
		const error = { headers: { "retry-after": "0", "x-ratelimit-after": "30" } };

		expect(getRetryAfterMs(error)).toBe(0);
		expect(isPdsRateLimitError(error)).toBe(true);
	});

	it("retries repeated 429 responses until login succeeds", async () => {
		const waits: number[] = [];
		let attempts = 0;
		const limiter = new PdsRateLimiter({
			minRetryMs: 100,
			maxRetryMs: 250,
			maxRetries: 4,
			now: () => 0,
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
			},
		});

		await limiter.login(async () => {
			attempts++;
			if (attempts < 4) throw rateLimitError("0");
		});

		expect(attempts).toBe(4);
		expect(waits).toEqual([100, 200, 250]);
	});

	it("rechecks full windows for overlapping logins", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const firstGate = Promise.withResolvers<void>();
		const firstWaitStarted = Promise.withResolvers<void>();
		const secondWaitStarted = Promise.withResolvers<"started">();
		const releaseSlotWaiters = Promise.withResolvers<void>();
		const waits: number[] = [];
		let now = 0;
		let sleepCalls = 0;
		let active = 0;
		let maxActive = 0;
		let firstAttempts = 0;

		const limiter = new PdsRateLimiter({
			loginLimit: 1,
			windowMs: 1_000,
			minRetryMs: 1,
			maxRetryMs: 1,
			maxRetries: 1,
			now: () => now,
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
				sleepCalls++;
				if (sleepCalls === 1) {
					firstWaitStarted.resolve();
					return;
				}
				if (sleepCalls === 2) {
					secondWaitStarted.resolve("started");
					await releaseSlotWaiters.promise;
					return;
				}
				now += milliseconds;
			},
			log: (message) => {
				if (message.startsWith("PDS returned 429")) releaseSlotWaiters.resolve();
			},
		});

		const first = limiter.login(async () => {
			firstAttempts++;
			active++;
			maxActive = Math.max(maxActive, active);
			firstStarted.resolve();
			if (firstAttempts === 1) {
				await firstGate.promise;
				active--;
				throw rateLimitError("0");
			}
			active--;
		});
		await firstStarted.promise;

		const second = limiter.login(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			active--;
		});
		await firstWaitStarted.promise;
		await secondWaitStarted.promise;

		firstGate.resolve();
		await Promise.all([first, second]);

		expect(waits[0]).toBe(2_000);
		expect(waits).toContain(1);
	});

	it("honors a server delay larger than local backoff", async () => {
		const waits: number[] = [];
		let attempts = 0;
		const limiter = new PdsRateLimiter({
			minRetryMs: 100,
			maxRetries: 1,
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
			},
		});

		await limiter.login(async () => {
			attempts++;
			if (attempts === 1) throw rateLimitError("0.5");
		});

		expect(attempts).toBe(2);
		expect(waits).toEqual([500]);
	});

	it("rethrows non-rate-limit errors without retrying", async () => {
		const failure = new Error("invalid credentials");
		const waits: number[] = [];
		let attempts = 0;
		const limiter = new PdsRateLimiter({
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
			},
		});

		await expect(
			limiter.login(async () => {
				attempts++;
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(attempts).toBe(1);
		expect(waits).toEqual([]);
	});

	it("stops after the configured retry budget", async () => {
		const failure = rateLimitError("0");
		const waits: number[] = [];
		let attempts = 0;
		const limiter = new PdsRateLimiter({
			minRetryMs: 100,
			maxRetries: 2,
			sleep: async (milliseconds) => {
				waits.push(milliseconds);
			},
		});

		await expect(
			limiter.login(async () => {
				attempts++;
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(attempts).toBe(3);
		expect(waits).toEqual([100, 200]);
	});
});

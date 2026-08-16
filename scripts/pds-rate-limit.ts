export interface PdsRateLimiterOptions {
	loginLimit?: number;
	windowMs?: number;
	minRetryMs?: number;
	maxRetryMs?: number;
	maxRetries?: number;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	log?: (message: string) => void;
}

type HeaderMap = Record<string, unknown>;
type ErrorShape = {
	error?: unknown;
	headers?: unknown;
	name?: unknown;
	status?: unknown;
};

const DEFAULT_LOGIN_LIMIT = 4;
const DEFAULT_WINDOW_MS = 300_000;
const DEFAULT_MIN_RETRY_MS = 30_000;
const DEFAULT_MAX_RETRY_MS = 300_000;
const DEFAULT_MAX_RETRIES = 5;

function errorShape(error: unknown): ErrorShape {
	return typeof error === "object" && error !== null ? (error as ErrorShape) : {};
}

function headerValue(headers: unknown, name: string): string | null {
	if (typeof headers !== "object" || headers === null) return null;
	const headerObject = headers as HeaderMap & { get?: (headerName: string) => unknown };
	if (typeof headerObject.get === "function") {
		const value = headerObject.get(name);
		return typeof value === "string" ? value : null;
	}
	for (const [key, value] of Object.entries(headerObject)) {
		if (key.toLowerCase() === name && typeof value === "string") return value;
	}
	return null;
}

function retryAfterHeader(error: unknown): string | null {
	const headers = errorShape(error).headers;
	return headerValue(headers, "retry-after") ?? headerValue(headers, "x-ratelimit-after");
}

export function getRetryAfterMs(error: unknown, now = Date.now()): number | null {
	const value = retryAfterHeader(error);
	if (value === null) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return null;
	return Math.max(0, timestamp - now);
}

export function isPdsRateLimitError(error: unknown): boolean {
	const shape = errorShape(error);
	const status = shape.status;
	if (status === 429 || status === "429") return true;
	if (shape.error === "RateLimitExceeded" || shape.name === "RateLimitExceeded") return true;
	if (status !== undefined && status !== null) return false;
	return retryAfterHeader(error) !== null;
}

interface LoginReservation {
	timestamp: number;
}

interface SlotAvailability {
	reservation: LoginReservation | null;
	waitMs: number;
}

export class PdsRateLimiter {
	private readonly loginLimit: number;
	private readonly windowMs: number;
	private readonly minRetryMs: number;
	private readonly maxRetryMs: number;
	private readonly maxRetries: number;
	private readonly now: () => number;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly log?: (message: string) => void;
	private readonly loginReservations: LoginReservation[] = [];
	private slotQueue: Promise<void> = Promise.resolve();

	constructor(options: PdsRateLimiterOptions = {}) {
		this.loginLimit = options.loginLimit ?? DEFAULT_LOGIN_LIMIT;
		this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
		this.minRetryMs = options.minRetryMs ?? DEFAULT_MIN_RETRY_MS;
		this.maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
		this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.now = options.now ?? Date.now;
		this.sleep =
			options.sleep ??
			((milliseconds) => {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, milliseconds);
				return promise;
			});
		this.log = options.log;
	}

	async login(loginRequest: () => Promise<void>): Promise<void> {
		for (let retry = 0; ; retry++) {
			const reservation = await this.reserveLoginSlot();
			try {
				await loginRequest();
				return;
			} catch (error: unknown) {
				if (!isPdsRateLimitError(error) || retry >= this.maxRetries) throw error;
				await this.releaseLoginSlot(reservation);
				const retryAfterMs = getRetryAfterMs(error, this.now()) ?? 0;
				const serverDelayMs = Math.min(retryAfterMs, this.maxRetryMs);
				const backoffMs = Math.min(this.maxRetryMs, this.minRetryMs * 2 ** retry);
				const waitMs = Math.max(serverDelayMs, backoffMs);
				this.log?.(
					`PDS returned 429, retry ${retry + 1}/${this.maxRetries} in ${Math.ceil(waitMs / 1_000)}s...`,
				);
				await this.sleep(waitMs);
			}
		}
	}

	private async reserveLoginSlot(): Promise<LoginReservation> {
		for (; ;) {
			const availability = await this.withSlotLock((): SlotAvailability => {
				this.purgeExpiredLogins();
				const oldest = this.loginReservations[0];
				if (oldest && this.loginReservations.length >= this.loginLimit) {
					const waitMs = Math.max(1, oldest.timestamp + this.windowMs - this.now() + 1_000);
					return { reservation: null, waitMs };
				}
				const reservation = { timestamp: this.now() };
				this.loginReservations.push(reservation);
				return { reservation, waitMs: 0 };
			});
			if (availability.reservation) return availability.reservation;
			this.log?.(
				`PDS login limit reached (${this.loginLimit}/${this.windowMs / 60_000}min), waiting ${Math.ceil(availability.waitMs / 1_000)}s...`,
			);
			await this.sleep(availability.waitMs);
		}
	}

	private async releaseLoginSlot(reservation: LoginReservation): Promise<void> {
		await this.withSlotLock(() => {
			const index = this.loginReservations.indexOf(reservation);
			if (index >= 0) this.loginReservations.splice(index, 1);
		});
	}

	private async withSlotLock<T>(operation: () => T | PromiseLike<T>): Promise<T> {
		const previous = this.slotQueue;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.slotQueue = promise;
		await previous;
		try {
			return await operation();
		} finally {
			resolve();
		}
	}

	private purgeExpiredLogins(): void {
		const cutoff = this.now() - this.windowMs;
		while (this.loginReservations.length > 0 && this.loginReservations[0]!.timestamp <= cutoff) {
			this.loginReservations.shift();
		}
	}
}

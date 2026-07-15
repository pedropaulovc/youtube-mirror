import type { ChannelInfo } from "./youtube-api";
import { BIO_DISCLAIMER } from "./constants";

export function profileSourceSnapshot(info: ChannelInfo, bioSuffix?: string): string {
	return JSON.stringify({
		title: info.title ?? null,
		description: info.description ?? null,
		avatarUrl: info.avatarUrl ?? null,
		bannerUrl: info.bannerUrl ?? null,
		bioSuffix: bioSuffix ?? BIO_DISCLAIMER,
	});
}

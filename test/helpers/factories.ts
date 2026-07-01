import type { ChannelConfig, CommentItem, CommunityPostItem, VideoItem } from "../../worker/types";

export const TEST_CHANNEL_ID = "UCtest0000000000000000ab";

export function makeChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
	return {
		main: {
			passwordKey: "youtube-mirror-atproto-password-UCtest",
			atProtoAccount: "testchannel.selfhosted.social",
			email: "test@test.com",
		},
		rt: {
			passwordKey: "youtube-mirror-atproto-password-UCtest-rt",
			atProtoAccount: "testchannel-rt.selfhosted.social",
			email: "test-rt@test.com",
		},
		handle: "testchannel",
		...overrides,
	};
}

export function makeVideo(overrides: Partial<VideoItem> = {}): VideoItem {
	return {
		kind: "video",
		id: "vid001",
		channelId: TEST_CHANNEL_ID,
		channelTitle: "Test Channel",
		title: "My First Video",
		description: "A short description.",
		publishedAt: "2026-06-01T12:00:00Z",
		durationSeconds: 600,
		isShort: false,
		thumbnailUrl: "https://i.ytimg.com/vi/vid001/maxresdefault.jpg",
		thumbnailWidth: 1280,
		thumbnailHeight: 720,
		watchUrl: "https://www.youtube.com/watch?v=vid001",
		...overrides,
	};
}

export function makeCommunityPost(overrides: Partial<CommunityPostItem> = {}): CommunityPostItem {
	return {
		kind: "community",
		id: "UgPost001",
		channelId: TEST_CHANNEL_ID,
		text: "Hello community!",
		publishedText: "2 days ago",
		images: [],
		postUrl: "https://www.youtube.com/post/UgPost001",
		...overrides,
	};
}

export function makeComment(overrides: Partial<CommentItem> = {}): CommentItem {
	return {
		kind: "comment",
		id: "Comment001",
		channelId: TEST_CHANNEL_ID,
		parentItemId: "vid001",
		parentItemKind: "video",
		videoId: "vid001",
		authorChannelId: "UCviewer00000000000000ab",
		authorDisplayName: "@viewer",
		authorHandle: "viewer",
		text: "Great video!",
		publishedAt: "2026-06-01T13:00:00Z",
		isChannelOwner: false,
		...overrides,
	};
}

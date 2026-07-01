---
name: channel-this-old-tony
description: Provisioned mirror identifiers for the This Old Tony YouTube channel
metadata:
  type: reference
---

First live channel, provisioned 2026-07-01 with `maxItems: 10`.

- YouTube: `@ThisOldTony` → channelId `UC5NO8MgTQKHAWXp6z8Xl7yQ`, uploads `UU5NO8MgTQKHAWXp6z8Xl7yQ`
- Main Bluesky: `thisoldtony-mirr.selfhosted.social` → `did:plc:atjrpjy3fdpvwprspzrjjju7`
- RT Bluesky: `thisoldtony-mir-rt.selfhosted.social` → `did:plc:l7grh73xlpn4t64tolaoolbc`
- KV: `users:UC5NO8MgTQKHAWXp6z8Xl7yQ`; secrets `youtube-mirror-atproto-password-UC5NO8MgTQKHAWXp6z8Xl7yQ`(+`-rt`)
- Passwords + PLC rotation keys backed up in 1Password vault `youtube-mirror`.

Backfill posted the last 10 videos to main (external link cards + description self-reply
chains). RT is empty and that's correct: comments are only polled on videos published in
the last `COMMENT_LOOKBACK_HOURS = 48` (near-real-time capture, not historical backfill),
and the channel's newest upload predates that window — comments will flow to RT on the
next upload. See [[cd-deploys-on-merge]].

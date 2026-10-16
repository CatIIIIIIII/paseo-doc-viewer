import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { mediaChunkRpc } from "../shared/rpc";
import { humanSize } from "./format";
import { loadMedia, MAX_PLAYABLE_BYTES } from "./media";
import { ErrorState, LoadingState, MessageState, type Styles, ToolbarButton } from "./ui";
import { canPlayVideo, createMediaUrl, revokeMediaUrl, VideoElement } from "./web";

export interface VideoViewerProps {
  workspaceId: string;
  path: string;
  revision: string;
  mimeType: string;
  size: number;
  theme: PluginTheme;
  styles: Styles;
}

const AUTOLOAD_BYTES = 32 * 1024 * 1024;

type Playback =
  | { status: "idle" }
  | { status: "loading"; loaded: number }
  | { status: "ready"; url: string }
  | { status: "error"; error: unknown };

export function VideoViewer(props: VideoViewerProps) {
  const { mimeType, size, theme, styles } = props;
  const facts = `${mimeType}, ${humanSize(size)}`;
  if (!canPlayVideo) {
    return (
      <View style={styles.screen}>
        <MessageState
          theme={theme}
          styles={styles}
          icon="FileVideoCamera"
          title="Video playback is not available in the mobile app yet"
          detail={`${facts}. Open this workspace in Paseo on desktop or the web to play it.`}
        />
      </View>
    );
  }
  if (size > MAX_PLAYABLE_BYTES) {
    return (
      <View style={styles.screen}>
        <MessageState
          theme={theme}
          styles={styles}
          icon="FileVideoCamera"
          title="Too large to play in the app"
          detail={`${facts}. The limit is ${humanSize(MAX_PLAYABLE_BYTES)}.`}
        />
      </View>
    );
  }
  return <WebVideo key={props.revision} {...props} facts={facts} />;
}

function WebVideo({ workspaceId, path, revision, size, theme, styles, facts }: VideoViewerProps & { facts: string }) {
  const fetchChunk = useRpc(mediaChunkRpc);
  const [requested, setRequested] = useState(size <= AUTOLOAD_BYTES);
  const [attempt, setAttempt] = useState(0);
  const [playback, setPlayback] = useState<Playback>({ status: "idle" });

  useEffect(() => {
    if (!requested) return;
    const signal = { aborted: false };
    let url: string | null = null;
    setPlayback({ status: "loading", loaded: 0 });
    loadMedia((range) => fetchChunk({ workspaceId, path, ...range }), {
      signal,
      onProgress: ({ loaded }) => {
        if (!signal.aborted) setPlayback({ status: "loading", loaded });
      },
    }).then(
      (media) => {
        if (signal.aborted) return;
        url = createMediaUrl(media.parts, media.mimeType);
        setPlayback(url ? { status: "ready", url } : { status: "error", error: new Error("Video playback is unavailable") });
      },
      (error: unknown) => {
        if (!signal.aborted) setPlayback({ status: "error", error });
      },
    );
    return () => {
      signal.aborted = true;
      if (url) revokeMediaUrl(url);
    };
  }, [requested, attempt, fetchChunk, workspaceId, path, revision]);

  if (playback.status === "ready") {
    return (
      <View style={[styles.screen, { padding: styles.gutter, gap: 8 }]}>
        <View style={{ flex: 1, minHeight: 0 }}>
          <VideoElement uri={playback.url} label={path} background={theme.colors.surface0} />
        </View>
        <Text style={styles.muted}>{facts}</Text>
      </View>
    );
  }
  if (playback.status === "error") {
    return (
      <View style={styles.screen}>
        <ErrorState theme={theme} styles={styles} error={playback.error} onRetry={() => setAttempt((value) => value + 1)} />
      </View>
    );
  }
  if (playback.status === "loading") {
    return (
      <View style={styles.screen}>
        <LoadingState theme={theme} styles={styles} label={`Loading... ${humanSize(playback.loaded)} of ${humanSize(size)}`} />
      </View>
    );
  }
  return (
    <View style={styles.screen}>
      <MessageState
        theme={theme}
        styles={styles}
        icon="FileVideoCamera"
        title="Video"
        detail={facts}
        action={{ label: `Load video (${humanSize(size)})`, onPress: () => setRequested(true) }}
      />
    </View>
  );
}

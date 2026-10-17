import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { fileInfoRpc, fileChunkRpc } from "../shared/rpc";
import { decodeBase64, MEDIA_REQUEST_BYTES, yieldToUI } from "./media";
import { humanSize } from "./format";
import { canDownloadOriginal, createMediaUrl, DownloadLink, revokeMediaUrl } from "./web";
import { ToolbarButton, type Styles } from "./ui";
import { Icon } from "@getpaseo/plugin/client/react-native";

export function DownloadOriginal({ workspaceId, path, theme, styles }: { workspaceId: string; path: string; theme: PluginTheme; styles: Styles }) {
  const info = useRpc(fileInfoRpc);
  const chunk = useRpc(fileChunkRpc);
  const [status, setStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<{ url: string; name: string } | null>(null);
  const token = useRef(0);
  const url = useRef<string | null>(null);
  useEffect(() => () => { token.current++; if (url.current) revokeMediaUrl(url.current); }, []);
  if (!canDownloadOriginal) return null;
  const prepare = async () => {
    const attempt = ++token.current;
    if (url.current) { revokeMediaUrl(url.current); url.current = null; }
    setPrepared(null); setStatus("loading"); setError(""); setProgress("");
    try {
      await yieldToUI();
      if (token.current !== attempt) return;
      const file = await info({ workspaceId, path });
      if (token.current !== attempt) return;
      if (file.size > 128 * 1024 * 1024) throw new Error("Original download is limited to 128 MiB");
      const parts: Uint8Array[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const value = await chunk({ workspaceId, path, revision: file.revision, offset, length: MEDIA_REQUEST_BYTES });
        if (token.current !== attempt) return;
        const bytes = decodeBase64(value.data);
        const end: number = offset + bytes.length;
        if (value.revision !== file.revision || value.size !== file.size || value.offset !== offset || end > file.size ||
          (value.nextOffset === null ? end !== file.size : bytes.length === 0 || value.nextOffset !== end)) throw new Error("The file changed or the transfer was incomplete. Prepare again.");
        parts.push(bytes); setProgress(`${humanSize(end)} / ${humanSize(file.size)}`); offset = value.nextOffset;
        await yieldToUI();
        if (token.current !== attempt) return;
      }
      url.current = createMediaUrl(parts, file.mimeType);
      if (!url.current) throw new Error("Saving is unavailable in this client");
      setPrepared({ url: url.current, name: file.name }); setStatus("ready");
    } catch (failure) {
      if (token.current !== attempt) return;
      setStatus("idle"); setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return <View style={{ gap: 4 }}>
    <View style={[styles.toolbarGroup, { flexWrap: "wrap" }]}>
      {prepared ? (
        <DownloadLink uri={prepared.url} name={prepared.name} style={{ ...styles.button, paddingLeft: 8, paddingRight: 8 }}>
          <Icon name="Download" size={14} color={theme.colors.foreground} />
          <Text style={styles.buttonText}>{styles.compact ? "Save" : "Save original"}</Text>
        </DownloadLink>
      ) :
        <ToolbarButton theme={theme} styles={styles} icon="Download" label="Download original" disabled={status === "loading"} onPress={() => void prepare()} />}
      {status === "loading" ? <>
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} accessibilityLabel="Preparing original file" />
        <Text style={styles.label}>{progress || "Preparing…"}</Text>
        <ToolbarButton theme={theme} styles={styles} label="Cancel" onPress={() => { token.current++; setStatus("idle"); }} />
      </> : null}
    </View>
    {error ? <Text style={styles.danger} accessibilityRole="alert">{error}</Text> : null}
  </View>;
}

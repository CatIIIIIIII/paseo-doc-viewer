import type { PluginClientContext, PluginOpenScreenInput } from "@getpaseo/plugin/client";
import type { HostPlayAudio } from "./media";

let hostClient: PluginClientContext | null = null;

export function setHostClient(client: PluginClientContext | null): void {
  hostClient = client;
}

// playAudio arrived in Paseo after 0.11.2, so look it up at runtime instead of requiring it.
export function getPlayAudio(): HostPlayAudio | null {
  const play = (hostClient as unknown as { playAudio?: HostPlayAudio } | null)?.playAudio;
  return typeof play === "function" ? play.bind(hostClient) : null;
}

export function openHostScreen(input: PluginOpenScreenInput): void {
  hostClient?.openScreen(input);
}

import { useCallback } from "react";
// Every call in page order, marked settled before its caller resumes, so a check made after the
// settled mark has seen anything the caller sent in response.
const calls: { method: string; input: unknown; settled: boolean }[] = [];
(window as any).__rpcCalls = calls;
export async function callRpc(contract: { name: string }, input: unknown): Promise<unknown> {
  const call = { method: contract.name, input, settled: false };
  calls.push(call);
  try {
    const response = await fetch("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: contract.name, input }) });
    const value: any = await response.json();
    if (value.error) throw new Error(value.error);
    return value;
  } finally {
    call.settled = true;
  }
}
export function useRpc(contract: { name: string }) {
  return useCallback((input: unknown) => callRpc(contract, input), [contract.name]);
}
export function usePaseo() {
  return (globalThis as any).__fakePaseo;
}

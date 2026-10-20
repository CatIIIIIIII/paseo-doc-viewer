import { useCallback } from "react";
// Every call in page order, marked settled before its caller resumes, so a check made after the
// settled mark has seen anything the caller sent in response.
const calls: { method: string; input: unknown; settled: boolean }[] = [];
(window as any).__rpcCalls = calls;
export async function recordCall<T>(method: string, input: unknown, run: () => Promise<T>): Promise<T> {
  const call = { method, input, settled: false };
  calls.push(call);
  try {
    return await run();
  } finally {
    call.settled = true;
  }
}
export function callRpc(contract: { name: string }, input: unknown): Promise<unknown> {
  return recordCall(contract.name, input, async () => {
    const response = await fetch("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: contract.name, input }) });
    const value: any = await response.json();
    if (value.error) throw new Error(value.error);
    return value;
  });
}
export function useRpc(contract: { name: string }) {
  return useCallback((input: unknown) => callRpc(contract, input), [contract.name]);
}
export function usePaseo() {
  return (globalThis as any).__fakePaseo;
}

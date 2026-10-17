import { useCallback } from "react";
export function useRpc(contract: { name: string }) {
  return useCallback(async (input: unknown) => {
    const response = await fetch("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: contract.name, input }) });
    const value: any = await response.json();
    if (value.error) throw new Error(value.error);
    return value;
  }, [contract.name]);
}

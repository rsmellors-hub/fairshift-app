import { afterEach, describe, expect, it, vi } from "vitest";
import { startConfirmationPolling } from "@/lib/confirmation";
afterEach(()=>vi.useRealTimers());
describe("subscription confirmation timing",()=>{
 it("delays recovery, performs sequential checks, and stops after ten attempts",async()=>{
  vi.useFakeTimers();const check=vi.fn(async()=>false),recovery=vi.fn(),exhausted=vi.fn();
  const cancel=startConfirmationPolling(check,recovery,exhausted);
  expect(recovery).not.toHaveBeenCalled();expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(14_999);expect(recovery).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);expect(recovery).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(100_000);expect(check).toHaveBeenCalledTimes(10);expect(exhausted).toHaveBeenCalledOnce();cancel();
 });
 it("does not overlap slow requests and cancels queued checks on unmount",async()=>{
  vi.useFakeTimers();let resolve!:(active:boolean)=>void;
  const check=vi.fn(()=>new Promise<boolean>(done=>{resolve=done;}));
  const recovery=vi.fn(),cancel=startConfirmationPolling(check,recovery,vi.fn());
  await vi.advanceTimersByTimeAsync(12_000);expect(check).toHaveBeenCalledOnce();
  cancel();resolve(false);await vi.advanceTimersByTimeAsync(60_000);
  expect(check).toHaveBeenCalledOnce();expect(recovery).not.toHaveBeenCalled();
 });
 it("stops when authoritative status supplies a destination",async()=>{
  vi.useFakeTimers();const check=vi.fn(async()=>true),exhausted=vi.fn();
  const cancel=startConfirmationPolling(check,vi.fn(),exhausted);
  await vi.advanceTimersByTimeAsync(60_000);expect(check).toHaveBeenCalledOnce();expect(exhausted).not.toHaveBeenCalled();cancel();
 });
 it("keeps bounded recovery available through connection failures",async()=>{
  vi.useFakeTimers();const check=vi.fn(async()=>{throw new Error("offline");}),recovery=vi.fn(),exhausted=vi.fn();
  const cancel=startConfirmationPolling(check,recovery,exhausted);await vi.advanceTimersByTimeAsync(60_000);
  expect(check).toHaveBeenCalledTimes(10);expect(recovery).toHaveBeenCalled();expect(exhausted).toHaveBeenCalledOnce();cancel();
 });
});

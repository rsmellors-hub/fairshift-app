// Sequential, bounded checks; recovery remains available when automatic checks end.
export function startConfirmationPolling(check: () => Promise<boolean>, revealRecovery: () => void, exhausted: () => void) {
  let cancelled = false, attempts = 0;
  let timer: ReturnType<typeof setTimeout>;
  const recoveryTimer = setTimeout(revealRecovery, 15_000);
  async function poll() {
    if (cancelled) return;
    let complete = false;
    try {complete = await check();} catch { /* A temporary failure does not end the recovery window. */ }
    if (cancelled || complete) return;
    attempts += 1;
    if (attempts < 10) timer = setTimeout(poll, 3_000);
    else {revealRecovery(); exhausted();}
  }
  timer = setTimeout(poll, 3_000);
  return () => {cancelled = true; clearTimeout(timer); clearTimeout(recoveryTimer);};
}

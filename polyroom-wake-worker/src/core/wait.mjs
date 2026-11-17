export function createWait(clock) {
  let cancel = () => {};
  const wait = (ms) => new Promise((resolve) => {
    const finish = () => { clock.clearTimeout(timer); cancel = () => {}; resolve(); };
    const timer = clock.setTimeout(finish, ms);
    cancel = finish;
  });
  wait.cancel = () => cancel();
  return wait;
}

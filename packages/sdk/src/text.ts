/** "1 provider", "3 providers". `many` defaults to `one + "s"`. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** yoctoNEAR (decimal string) → "0.01" style NEAR, up to 6 decimals, no float rounding. */
export const formatNear = (yocto: string): string => {
  const v = /^\d+$/.test(yocto) ? yocto.padStart(25, "0") : "0".repeat(25);
  const whole = v.slice(0, -24).replace(/^0+(?=\d)/, "");
  const frac = v.slice(-24, -18).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

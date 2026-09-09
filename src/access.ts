import { z } from "zod";

export const editSecret = z.string().regex(/^fs_[A-Za-z0-9_-]{43}$/, "A valid scene edit secret is required");

export function createSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `fs_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

export async function secretHash(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function sameHash(left: string, right: string) {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

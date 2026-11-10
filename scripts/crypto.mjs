// Cifra y descifra con la misma contraseña que usa la página (AES-256-GCM + PBKDF2).
import { webcrypto as crypto } from "node:crypto";

const ITERATIONS = 310000;
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (text) => new Uint8Array(Buffer.from(text, "base64"));

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(object, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const body = new TextEncoder().encode(JSON.stringify(object));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, body);
  return JSON.stringify({ v: 1, n: ITERATIONS, s: b64(salt), i: b64(iv), c: b64(new Uint8Array(cipher)) });
}

export async function open(text, password) {
  const box = JSON.parse(text);
  const key = await deriveKey(password, unb64(box.s));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(box.i) }, key, unb64(box.c));
  return JSON.parse(new TextDecoder().decode(plain));
}

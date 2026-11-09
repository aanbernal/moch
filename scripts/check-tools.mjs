import { checkTools } from "../lib/exec.mjs";

// Exits 4 naming ffmpeg, ffprobe or pdftoppm when missing.
await checkTools();
console.log("Herramientas OK: ffmpeg, ffprobe, pdftoppm");

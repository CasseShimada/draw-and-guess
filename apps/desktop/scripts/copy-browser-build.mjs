import { access, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const source = path.join(repositoryRoot, "apps", "web", "dist");
const destination = path.join(desktopRoot, "dist", "browser");

await access(path.join(source, "index.html"));
await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });

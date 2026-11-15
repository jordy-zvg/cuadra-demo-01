import { defineConfig } from "vitest/config";

// Cada archivo crea su base en memoria (PGlite) y corre todas las migraciones: con muchos archivos en
// paralelo la primera prueba puede tardar más de un minuto en máquinas lentas. Margen amplio para que
// la lentitud no se confunda con un error.

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], setupFiles: ["test/setup.ts"], testTimeout: 180_000, hookTimeout: 180_000 },
});

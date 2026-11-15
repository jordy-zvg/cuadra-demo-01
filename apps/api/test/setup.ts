// Cada prueba crea su base en memoria (PGlite, ~250 MB); al terminar la prueba se cierra para no
// acumular memoria (sin esto, un archivo con muchas pruebas pasa de 10 GB y tumba el CI).
import { afterEach } from "vitest";
import { closeTestDbs } from "@cuadra/db/testing";

afterEach(closeTestDbs);

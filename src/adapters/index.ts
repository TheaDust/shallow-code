import { ApplicationRegistry } from "../application/registry.js";
import { webApplicationAdapter } from "./web/index.js";

/** Bundled implementations are selected only at executable composition roots. */
export const applications = new ApplicationRegistry([webApplicationAdapter]);

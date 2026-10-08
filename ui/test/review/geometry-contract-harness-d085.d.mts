// D085-S1 BEGIN: the VM harness deliberately exposes instrumented page and toolbar records.
export function load(root?: string): Promise<{ mod: any; mainSource: string }>;
export function makePage(mod: any, init?: Record<string, unknown>): any;
export function makeMain(mod: any, mainSource: string, page: any): Promise<any>;
export function macro(): Promise<void>;
export function tick(count?: number): Promise<void>;
export function wit(page: any): any;
// D085-S1 END

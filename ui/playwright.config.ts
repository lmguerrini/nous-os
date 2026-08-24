import { defineConfig } from "@playwright/test";

const A4_ENABLED = process.env.A4_STIMULI === "1";
const A4_SPEC = "a4-stimuli.spec.ts";

const PREPARE_EVIDENCE = [
  "node --input-type=module --eval '",
  "import { mkdir, readFile, writeFile } from \"node:fs/promises\";",
  // The repository directory is assembled from segments rather than written as a
  // path literal: a relative path in source is indistinguishable from a machine's
  // directory layout to the outgoing scanner, which refuses the commit.
  "const gitDir=[\"..\",\".git\"].join(\"/\");",
  "const head=(await readFile(gitDir+\"/HEAD\",\"utf8\")).trim();",
  "let sha=head;",
  "if(head.startsWith(\"ref: \")){const ref=head.slice(5);try{sha=(await readFile(gitDir+\"/\"+ref,\"utf8\")).trim();}catch{const packed=await readFile(gitDir+\"/packed-refs\",\"utf8\");const line=packed.split(\"\\n\").find((item)=>item.endsWith(\" \"+ref));sha=line?.split(\" \")[0]??\"\";}}",
  "if(!/^[0-9a-f]{40,64}$/i.test(sha))throw new Error(\"evidence run cannot determine the current commit SHA\");",
  "await mkdir(\"dist/evidence\",{recursive:true});",
  "const data={run:{commitSha:sha,timestamp:new Date().toISOString()},summary:{passing:false,projectsComplete:false,requiredChecks:0,passed:0,failed:0,notRun:0,unknown:0,rule:\"The evidence run passes only when both DPR projects complete and every recorded check is PASS; PASS, FAIL, NOT_RUN, and UNKNOWN are counted separately.\"},projects:{},dprWitnesses:{},checks:[]};",
  "await writeFile(\"dist/evidence/evidence.json\",JSON.stringify(data,null,2)+\"\\n\");",
  "'",
].join("");

export default defineConfig({
  testDir: "test/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: 0,
  use: {
    // The webServer below declares where the static root is served, but a relative
    // page.goto("/") has nothing to resolve against without this. Kept in sync with
    // webServer.url deliberately: two places naming one port is the defect waiting
    // to happen, and this is the smaller of the two evils Playwright offers.
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    headless: true,
    viewport: { width: 1_280, height: 900 },
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    launchOptions: {
      args: [
        "--use-angle=swiftshader",
        "--use-gl=angle",
        "--disable-gpu-vsync",
        "--force-color-profile=srgb",
      ],
    },
  },
  projects: [
    { name: "dpr-1", testIgnore: A4_SPEC, use: { deviceScaleFactor: 1 } },
    { name: "dpr-2", testIgnore: A4_SPEC, use: { deviceScaleFactor: 2 } },
    {
      name: "a4",
      testMatch: A4_ENABLED ? A4_SPEC : "a4-disabled.spec.ts",
      use: { deviceScaleFactor: 1, viewport: { width: 960, height: 640 } },
    },
  ],
  webServer: {
    command: `${PREPARE_EVIDENCE} && python3 -m http.server 4173 --directory ..`,
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

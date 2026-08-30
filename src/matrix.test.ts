import { describe, expect, test } from "bun:test";
import { buildMatrix, composeFiles, targetUrl, workloadConfig } from "./matrix";

describe("buildMatrix", () => {
  test("full matrix has 22 sessions", () => {
    const m = buildMatrix(false);
    expect(m.length).toBe(22);
  });

  test("smoke matrix filters to plaintext, all workloads except segment-serve", () => {
    const m = buildMatrix(true);
    expect(m.length).toBe(9);
    for (const s of m) {
      expect(s.topology).toBe("plaintext");
      expect(s.workload).not.toBe("segment-serve");
    }
  });

  test("vinyl/tls-inprocess is excluded", () => {
    const m = buildMatrix(false);
    const vinylTls = m.filter((s) => s.engine === "vinyl" && s.topology === "tls-inprocess");
    expect(vinylTls.length).toBe(0);
  });

  test("W3/W4 only run on plaintext", () => {
    const m = buildMatrix(false);
    const nonPlainW3W4 = m.filter((s) => (s.workload === "miss-storm" || s.workload === "origin-flap") && s.topology !== "plaintext");
    expect(nonPlainW3W4.length).toBe(0);
  });
});

describe("composeFiles", () => {
  test("plaintext returns base file only", () => {
    const files = composeFiles({ engine: "varnish", topology: "plaintext", workload: "hit-path-rps", label: "" });
    expect(files).toEqual(["docker-compose.varnish.yml"]);
  });

  test("tls-inprocess adds topology overlay", () => {
    const files = composeFiles({ engine: "nginx", topology: "tls-inprocess", workload: "hit-path-rps", label: "" });
    expect(files).toEqual(["docker-compose.nginx.yml", "topology-tls.nginx.yml"]);
  });

  test("proxyv2-haproxy adds shared + engine overlay", () => {
    const files = composeFiles({ engine: "vinyl", topology: "proxyv2-haproxy", workload: "segment-serve", label: "" });
    expect(files).toEqual(["docker-compose.vinyl.yml", "topology-proxyv2.yml", "topology-proxyv2.vinyl.yml"]);
  });
});

describe("targetUrl", () => {
  test("plaintext uses http port 6081", () => {
    expect(targetUrl({ engine: "varnish", topology: "plaintext", workload: "hit-path-rps", label: "" }, "/test")).toBe("http://localhost:6081/test");
  });

  test("non-plaintext uses https port 6443", () => {
    expect(targetUrl({ engine: "nginx", topology: "tls-inprocess", workload: "hit-path-rps", label: "" }, "/test")).toBe("https://localhost:6443/test");
  });
});

describe("workloadConfig", () => {
  test("hit-path-rps targets 5000 rps", () => {
    expect(workloadConfig("hit-path-rps").rps).toBe(5000);
  });

  test("miss-storm uses 200 concurrency", () => {
    expect(workloadConfig("miss-storm").concurrency).toBe(200);
  });
});

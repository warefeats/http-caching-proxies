#!/usr/bin/env bun
import { App } from "aws-cdk-lib";
import { ProxyBenchStack } from "../lib/proxy-bench-stack";

const app = new App();

new ProxyBenchStack(app, "WarefeatsProxyBench", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});

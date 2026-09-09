import type { NextConfig } from "next";

const suffix = process.env.BASE44_PUBLIC_HOST_SUFFIX;
const nextConfig: NextConfig = {
  allowedDevOrigins: suffix ? ["3000-" + suffix] : undefined,
};

export default nextConfig;

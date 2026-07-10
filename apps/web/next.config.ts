import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withContentCollections } from "@content-collections/next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
	turbopack: {
		rules: {
			"*.glsl": {
				loaders: [require.resolve("raw-loader")],
				as: "*.js",
			},
			// Agent skill knowledge files — imported as raw text so the AI
			// agent can read technique recipes at runtime.
			"*.skill.md": {
				loaders: [require.resolve("raw-loader")],
				as: "*.js",
			},
		},
	},
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	webpack(config) {
		config.experiments = {
			...config.experiments,
			asyncWebAssembly: true,
		};
		config.module.rules.push({
			test: /\.glsl$/,
			use: "raw-loader",
		});
		config.module.rules.push({
			test: /\.skill\.md$/,
			use: "raw-loader",
		});
		return config;
	},
	productionBrowserSourceMaps: true,
	output: "standalone",
	devIndicators: {
		position: "bottom-right",
	},
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "plus.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.marblecms.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
			{
				protocol: "https",
				hostname: "cdn.brandfetch.io",
			},
		],
	},
};

export default withContentCollections(withBotId(nextConfig));

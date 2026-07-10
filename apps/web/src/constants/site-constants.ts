import { OcDataBuddyIcon, OcMarbleIcon } from "@chronox/ui/icons";

export const SITE_URL = "https://chronox.app";

export const SITE_INFO = {
	title: "ChronoX",
	description:
		"An Agentic AI video workspace that empowers beginners to edit frames using natural language.",
	url: SITE_URL,
	openGraphImage: "/open-graph/default.jpg",
	twitterImage: "/open-graph/default.jpg",
	favicon: "/favicon.ico",
};

export type ExternalTool = {
	name: string;
	description: string;
	url: string;
	icon: React.ElementType;
};

export const EXTERNAL_TOOLS: ExternalTool[] = [
	{
		name: "Marble",
		description:
			"Modern headless CMS for content management and the blog for ChronoX",
		url: "https://marblecms.com?utm_source=chronox",
		icon: OcMarbleIcon,
	},
	{
		name: "Databuddy",
		description: "GDPR compliant analytics and user insights for ChronoX",
		url: "https://databuddy.cc?utm_source=chronox",
		icon: OcDataBuddyIcon,
	},
];

export const DEFAULT_LOGO_URL = "/logo.png";

export const SOCIAL_LINKS = {
	x: "https://x.com/chronox",
	github: "https://github.com/chronox/chronox",
	discord: "https://discord.com/invite/Mu3acKZvCp",
};

export type Sponsor = {
	name: string;
	url: string;
	logo: string;
	description: string;
	invertOnDark?: boolean;
};

export const SPONSORS: Sponsor[] = [
	{
		name: "Fal.ai",
		url: "https://fal.ai?utm_source=chronox",
		logo: "/logos/others/fal.svg",
		description: "Generative image, video, and audio models all in one place.",
		invertOnDark: true,
	},
	{
		name: "Vercel",
		url: "https://vercel.com?utm_source=chronox",
		logo: "/logos/others/vercel.svg",
		description: "Platform where we deploy and host ChronoX.",
		invertOnDark: true,
	},
];

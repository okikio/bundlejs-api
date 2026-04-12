import type { BuildConfig } from "@bundle/core";
import type { CompressConfig } from "@bundle/compress";

export type BundleModuleMode = "import" | "export" | (string & {});
export type BundleModule = [string, BundleModuleMode];

export type Config = BuildConfig & {
	compression?: CompressConfig;
	analysis?: boolean | string;
	tsx?: boolean;
};

export type BundleKeyObject = Omit<Config, "entryPoints"> & {
	entryPoints?: Config["entryPoints"];
	init: NonNullable<Config["init"]>;
	versions: string[];
	modules: BundleModule[];
	initialValue: string;
};

export type PreparedBundleRequest = {
	bundleKey: string;
	query: string;
	initialValue: string;
	initialConfig: Config;
	earlyConfig: Config;
	versions: string[];
	modules: BundleModule[];
	jsonKeyObject: BundleKeyObject;
	jsonKey: string;
	badgeKey: string;
	badgeID: string;
	exportAll: boolean;
	mutationQueries: boolean;
	shareQuery: string | null;
	textQuery: string | null;
	useTsxEntrypoint: boolean;
};
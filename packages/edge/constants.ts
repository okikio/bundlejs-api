export const headers = Object.entries({
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET"
});

export const PACKAGE_RESULT_PREFIX = "json-package";

export const inputModelResetValue = [
	'export * from "spring-easing";',
	'export { default } from "spring-easing";'
].join("\n");
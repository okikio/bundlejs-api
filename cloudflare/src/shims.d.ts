declare module "flow-remove-types" {
  type FlowRemoveTypesOptions = {
    pretty?: boolean;
    all?: boolean;
  };

  type FlowRemoveTypesResult = {
    toString(): string;
    generateMap(): unknown;
  };

  export default function flowRemoveTypes(
    source: string,
    options?: FlowRemoveTypesOptions
  ): FlowRemoveTypesResult;
}

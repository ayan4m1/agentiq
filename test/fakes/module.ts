// a fake only fills in what the code under test reaches for, so everything it
// leaves out is optional - but whatever it does fill in has to look like the
// real thing, all the way down, so tsc notices when the real thing moves on
type DeepPartial<T> =
  T extends Promise<infer U>
    ? Promise<DeepPartial<U>>
    : T extends (...args: infer A) => infer R
      ? // something callable that also has members, like a tokenizer, can be
        // stood in for by an object with just the members that get used
        [keyof T] extends [never]
        ? (...args: A) => DeepPartial<R>
        : ((...args: A) => DeepPartial<R>) | PartialObject<T>
      : T extends readonly (infer U)[]
        ? DeepPartial<U>[]
        : T extends object
          ? PartialObject<T>
          : // a fake holds a value of its own, not necessarily the real one -
            // a threshold of 0.5 where the real module says 0.8
            T extends string
            ? string
            : T extends number
              ? number
              : T extends boolean
                ? boolean
                : T;

type PartialObject<T> = { [K in keyof T]?: DeepPartial<T[K]> };

// what a mock.module call may export in place of the module M - checked with
// `satisfies`, which also refuses an export the real module no longer has
export type ModuleMock<M> = PartialObject<M>;

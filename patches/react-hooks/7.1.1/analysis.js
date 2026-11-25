function validateNoSetStateInEffects(fn, env) {
  const setStateFunctions = new Map();
  const errors = new CompilerError();
  let hasEffectEvent = false;
  const effectFunctions = collectEffectTimingFunctions(fn);
  let effectSummaries = computeEffectTimingSummaries(
    effectFunctions,
    setStateFunctions,
    env,
  );
  for (const [, block] of fn.body.blocks) {
    for (const instr of block.instructions) {
      switch (instr.value.kind) {
        case "LoadLocal": {
          if (setStateFunctions.has(instr.value.place.identifier.id)) {
            setStateFunctions.set(
              instr.lvalue.identifier.id,
              instr.value.place,
            );
          }
          break;
        }
        case "StoreLocal": {
          if (setStateFunctions.has(instr.value.value.identifier.id)) {
            setStateFunctions.set(
              instr.value.lvalue.place.identifier.id,
              instr.value.value,
            );
            setStateFunctions.set(
              instr.lvalue.identifier.id,
              instr.value.value,
            );
          }
          break;
        }
        case "FunctionExpression": {
          if (hasEffectEvent)
            effectSummaries = computeEffectTimingSummaries(
              effectFunctions,
              setStateFunctions,
              env,
            );
          if (
            [...eachInstructionValueOperand(instr.value)].some(
              (operand) =>
                isSetStateType(operand.identifier) ||
                setStateFunctions.has(operand.identifier.id),
            )
          ) {
            const callee =
              effectSummaries.get(instr.value.loweredFunc.func) ?? null;
            if (callee !== null) {
              setStateFunctions.set(instr.lvalue.identifier.id, callee);
            }
          }
          break;
        }
        case "MethodCall":
        case "CallExpression": {
          const callee =
            instr.value.kind === "MethodCall"
              ? instr.value.property
              : instr.value.callee;
          if (isUseEffectEventType(callee.identifier)) {
            hasEffectEvent = true;
            const arg = instr.value.args[0];
            if (arg !== undefined && arg.kind === "Identifier") {
              const setState = setStateFunctions.get(arg.identifier.id);
              if (setState !== undefined) {
                setStateFunctions.set(instr.lvalue.identifier.id, setState);
                effectSummaries = computeEffectTimingSummaries(
                  effectFunctions,
                  setStateFunctions,
                  env,
                );
              }
            }
          } else if (
            isUseEffectHookType(callee.identifier) ||
            isUseLayoutEffectHookType(callee.identifier) ||
            isUseInsertionEffectHookType(callee.identifier)
          ) {
            const arg = instr.value.args[0];
            if (arg !== undefined && arg.kind === "Identifier") {
              const setState = setStateFunctions.get(arg.identifier.id);
              if (setState !== undefined) {
                const enableVerbose =
                  env.config.enableVerboseNoSetStateInEffect;
                if (enableVerbose) {
                  errors.pushDiagnostic(
                    CompilerDiagnostic.create({
                      category: ErrorCategory.EffectSetState,
                      reason:
                        "Calling setState synchronously within an effect can trigger cascading renders",
                      description:
                        "Effects are intended to synchronize state between React and external systems. " +
                        "Calling setState synchronously causes cascading renders that hurt performance.\n\n" +
                        "This pattern may indicate one of several issues:\n\n" +
                        "**1. Non-local derived data**: If the value being set could be computed from props/state " +
                        "but requires data from a parent component, consider restructuring state ownership so the " +
                        "derivation can happen during render in the component that owns the relevant state.\n\n" +
                        "**2. Derived event pattern**: If you're detecting when a prop changes (e.g., `isPlaying` " +
                        "transitioning from false to true), this often indicates the parent should provide an event " +
                        "callback (like `onPlay`) instead of just the current state. Request access to the original event.\n\n" +
                        "**3. Force update / external sync**: If you're forcing a re-render to sync with an external " +
                        "data source (mutable values outside React), use `useSyncExternalStore` to properly subscribe " +
                        "to external state changes.\n\n" +
                        "See: https://react.dev/learn/you-might-not-need-an-effect",
                      suggestions: null,
                    }).withDetails({
                      kind: "error",
                      loc: setState.loc,
                      message:
                        "Avoid calling setState() directly within an effect",
                    }),
                  );
                } else {
                  errors.pushDiagnostic(
                    CompilerDiagnostic.create({
                      category: ErrorCategory.EffectSetState,
                      reason:
                        "Calling setState synchronously within an effect can trigger cascading renders",
                      description:
                        "Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. " +
                        "In general, the body of an effect should do one or both of the following:\n" +
                        "* Update external systems with the latest state from React.\n" +
                        "* Subscribe for updates from some external system, calling setState in a callback function when external state changes.\n\n" +
                        "Calling setState synchronously within an effect body causes cascading renders that can hurt performance, and is not recommended. " +
                        "(https://react.dev/learn/you-might-not-need-an-effect)",
                      suggestions: null,
                    }).withDetails({
                      kind: "error",
                      loc: setState.loc,
                      message:
                        "Avoid calling setState() directly within an effect",
                    }),
                  );
                }
              }
            }
          }
          break;
        }
      }
    }
  }
  return errors.asResult();
}
function getSetStateCall(
  fn,
  setStateFunctions,
  env,
  effectFunctions = new Map(),
  effectSummaries = new Map(),
  throws = new Map(),
) {
  const synchronousBlocks = effectTimingSynchronousBlocks(
    fn,
    effectFunctions,
    throws,
  );
  const enableAllowSetStateFromRefsInEffects =
    env.config.enableAllowSetStateFromRefsInEffects;
  const refDerivedValues = new Set();
  const isDerivedFromRef = (place) => {
    return (
      refDerivedValues.has(place.identifier.id) ||
      isUseRefType(place.identifier) ||
      isRefValueType(place.identifier)
    );
  };
  const isRefControlledBlock = enableAllowSetStateFromRefsInEffects
    ? createControlDominators(fn, (place) => isDerivedFromRef(place))
    : () => false;
  for (const [blockId, block] of fn.body.blocks) {
    if (!synchronousBlocks.has(blockId)) continue;
    if (enableAllowSetStateFromRefsInEffects) {
      for (const phi of block.phis) {
        if (isDerivedFromRef(phi.place)) {
          continue;
        }
        let isPhiDerivedFromRef = false;
        for (const [, operand] of phi.operands) {
          if (isDerivedFromRef(operand)) {
            isPhiDerivedFromRef = true;
            break;
          }
        }
        if (isPhiDerivedFromRef) {
          refDerivedValues.add(phi.place.identifier.id);
        } else {
          for (const [pred] of phi.operands) {
            if (isRefControlledBlock(pred)) {
              refDerivedValues.add(phi.place.identifier.id);
              break;
            }
          }
        }
      }
    }
    for (const instr of block.instructions) {
      if (instr.value.kind === "Await") break;
      if (enableAllowSetStateFromRefsInEffects) {
        const hasRefOperand = Iterable_some(
          eachInstructionValueOperand(instr.value),
          isDerivedFromRef,
        );
        if (hasRefOperand) {
          for (const lvalue of eachInstructionLValue(instr)) {
            refDerivedValues.add(lvalue.identifier.id);
          }
          for (const operand of eachInstructionValueOperand(instr.value)) {
            switch (operand.effect) {
              case Effect.Capture:
              case Effect.Store:
              case Effect.ConditionallyMutate:
              case Effect.ConditionallyMutateIterator:
              case Effect.Mutate: {
                if (isMutable(instr, operand)) {
                  refDerivedValues.add(operand.identifier.id);
                }
                break;
              }
              case Effect.Freeze:
              case Effect.Read: {
                break;
              }
              case Effect.Unknown: {
                CompilerError.invariant(false, {
                  reason: "Unexpected unknown effect",
                  loc: operand.loc,
                });
              }
              default: {
                assertExhaustive$1(
                  operand.effect,
                  `Unexpected effect kind \`${operand.effect}\``,
                );
              }
            }
          }
        }
        if (
          instr.value.kind === "PropertyLoad" &&
          instr.value.property === "current" &&
          (isUseRefType(instr.value.object.identifier) ||
            isRefValueType(instr.value.object.identifier))
        ) {
          refDerivedValues.add(instr.lvalue.identifier.id);
        }
      }
      switch (instr.value.kind) {
        case "LoadLocal": {
          if (setStateFunctions.has(instr.value.place.identifier.id)) {
            setStateFunctions.set(
              instr.lvalue.identifier.id,
              instr.value.place,
            );
          }
          break;
        }
        case "StoreLocal": {
          if (setStateFunctions.has(instr.value.value.identifier.id)) {
            setStateFunctions.set(
              instr.value.lvalue.place.identifier.id,
              instr.value.value,
            );
            setStateFunctions.set(
              instr.lvalue.identifier.id,
              instr.value.value,
            );
          }
          break;
        }
        case "MethodCall":
        case "CallExpression": {
          const callee =
            instr.value.kind === "MethodCall"
              ? instr.value.property
              : instr.value.callee;
          const candidates = effectFunctions.get(callee.identifier.id);
          const summary =
            candidates === undefined
              ? null
              : [...candidates]
                  .map((fn) => effectSummaries.get(fn))
                  .find((value) => value != null);
          if (
            summary != null ||
            isSetStateType(callee.identifier) ||
            setStateFunctions.has(callee.identifier.id)
          ) {
            if (enableAllowSetStateFromRefsInEffects) {
              const arg = instr.value.args.at(0);
              if (
                arg !== undefined &&
                arg.kind === "Identifier" &&
                refDerivedValues.has(arg.identifier.id)
              ) {
                return null;
              } else if (isRefControlledBlock(block.id)) {
                continue;
              }
            }
            return summary ?? callee;
          }
        }
      }
    }
  }
  return null;
}

// The summaries below describe only work that can occur before the current
// function suspends. Invoking an async function does not suspend its caller.
function collectEffectTimingFunctions(root) {
  const functions = new Map();
  functions.propertyLoads = new Set();
  const objects = new Map();
  const instructions = [];
  const phis = [];
  const visited = new Set();
  function merge(map, id, candidates) {
    if (candidates === undefined) return false;
    let target = map.get(id);
    if (target === undefined) {
      target = new Set();
      map.set(id, target);
    }
    const size = target.size;
    for (const candidate of candidates) target.add(candidate);
    return target.size !== size;
  }
  function collect(fn) {
    if (visited.has(fn)) return;
    visited.add(fn);
    for (const [, block] of fn.body.blocks) {
      phis.push(...block.phis);
      for (const instr of block.instructions) {
        instructions.push(instr);
        const value = instr.value;
        if (
          value.kind === "FunctionExpression" ||
          value.kind === "ObjectMethod"
        ) {
          merge(functions, instr.lvalue.identifier.id, [
            value.loweredFunc.func,
          ]);
          collect(value.loweredFunc.func);
        } else if (value.kind === "ObjectExpression") {
          const properties = new Map();
          let supported = true;
          for (const property of value.properties) {
            if (
              property.kind !== "ObjectProperty" ||
              property.key.kind !== "identifier" ||
              property.type === "get" ||
              property.type === "set"
            ) {
              supported = false;
              break;
            }
            properties.set(property.key.name, property.place.identifier.id);
          }
          if (supported)
            merge(objects, instr.lvalue.identifier.id, [properties]);
        }
      }
    }
  }
  collect(root);
  function aliases(includeProperties, unsafeObjects) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const phi of phis)
        for (const [, operand] of phi.operands) {
          for (const map of [functions, objects])
            changed =
              merge(
                map,
                phi.place.identifier.id,
                map.get(operand.identifier.id),
              ) || changed;
        }
      for (const instr of instructions) {
        const value = instr.value;
        const source =
          value.kind === "LoadLocal" || value.kind === "LoadContext"
            ? value.place
            : value.kind === "StoreLocal" || value.kind === "StoreContext"
              ? value.value
              : null;
        const ids = [
          instr.lvalue.identifier.id,
          ...(value.kind === "StoreLocal" || value.kind === "StoreContext"
            ? [value.lvalue.place.identifier.id]
            : []),
        ];
        if (source !== null) {
          for (const map of [functions, objects])
            for (const id of ids)
              changed =
                merge(map, id, map.get(source.identifier.id)) || changed;
        } else if (includeProperties && value.kind === "PropertyLoad") {
          const candidates = objects.get(value.object.identifier.id);
          if (
            candidates === undefined ||
            [...candidates].some((object) => unsafeObjects.has(object))
          )
            continue;
          let resolved = true;
          for (const object of candidates) {
            const target = functions.get(object.get(value.property));
            if (target === undefined) resolved = false;
            changed =
              merge(functions, instr.lvalue.identifier.id, target) || changed;
          }
          if (resolved) functions.propertyLoads.add(value);
        }
      }
    }
  }
  aliases(false, new Set());
  // A local literal method is resolved only while its object does not escape
  // or receive writes. Dynamic dispatch retains upstream treatment.
  const unsafeObjects = new Set();
  for (const instr of instructions) {
    const value = instr.value;
    const places =
      value.kind === "CallExpression" || value.kind === "MethodCall"
        ? value.args.filter((arg) => arg.kind === "Identifier")
        : value.kind === "PropertyStore" || value.kind === "ComputedStore"
          ? [...eachInstructionValueOperand(value)]
          : [];
    for (const place of places)
      for (const object of objects.get(place.identifier.id) ?? [])
        unsafeObjects.add(object);
  }
  aliases(true, unsafeObjects);
  return functions;
}
function computeEffectTimingSummaries(functions, setters, env) {
  const summaries = new Map();
  const unique = new Set(
    [...functions.values()].flatMap((candidates) => [...candidates]),
  );
  const throws = computeEffectTimingThrows(functions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of unique) {
      if (summaries.has(fn)) continue;
      const summary = getSetStateCall(
        fn,
        new Map(setters),
        env,
        functions,
        summaries,
        throws,
      );
      if (summary !== null) {
        summaries.set(fn, summary);
        changed = true;
      }
    }
  }
  return summaries;
}
function effectTimingInstructionMayThrow(value, functions, throws) {
  switch (value.kind) {
    case "Await":
    case "Primitive":
    case "LoadLocal":
    case "LoadContext":
    case "StoreLocal":
    case "DeclareLocal":
    case "FunctionExpression":
    case "ObjectMethod":
      return false;
    case "PropertyLoad":
      return !functions.propertyLoads?.has(value);
    case "MethodCall":
    case "CallExpression": {
      const candidates = functions.get(
        (value.kind === "MethodCall" ? value.property : value.callee).identifier
          .id,
      );
      return (
        candidates === undefined ||
        [...candidates].some((fn) => !fn.async && throws.get(fn) === true)
      );
    }
    default:
      return true;
  }
}
function effectTimingSynchronousBlocks(fn, functions, throws) {
  const reachable = new Set();
  const pending = [fn.body.entry];
  while (pending.length !== 0) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const block = fn.body.blocks.get(id);
    if (block === undefined) continue;
    let suspended = false;
    let mayThrow = false;
    for (const instr of block.instructions) {
      if (instr.value.kind === "Await") {
        suspended = true;
        break;
      }
      mayThrow ||= effectTimingInstructionMayThrow(
        instr.value,
        functions,
        throws,
      );
    }
    const terminal = block.terminal;
    if (terminal.kind === "maybe-throw") {
      if (!suspended) pending.push(terminal.continuation);
      // Explicit throw is represented by a continuation terminal, not an instruction.
      const explicitThrow =
        fn.body.blocks.get(terminal.continuation)?.terminal.kind === "throw";
      if (
        (mayThrow || (!suspended && explicitThrow)) &&
        terminal.handler !== null
      )
        pending.push(terminal.handler);
    } else if (!suspended) {
      for (const successor of eachTerminalSuccessor(terminal))
        pending.push(successor);
    }
  }
  return reachable;
}

// Async functions return rejections to their caller, including exceptions before
// their first await. Their own local handlers can still run synchronously.
function computeEffectTimingThrows(functions) {
  const throws = new Map();
  const unique = new Set(
    [...functions.values()].flatMap((candidates) => [...candidates]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of unique) {
      if (fn.async || throws.get(fn) === true) continue;
      const reachable = effectTimingSynchronousBlocks(fn, functions, throws);
      for (const [id, block] of fn.body.blocks) {
        if (!reachable.has(id)) continue;
        const terminal = block.terminal;
        const caughtThrow = [...fn.body.blocks.values()].some(
          (predecessor) =>
            predecessor.terminal.kind === "maybe-throw" &&
            predecessor.terminal.continuation === id &&
            predecessor.terminal.handler !== null,
        );
        const escapes =
          terminal.kind === "throw"
            ? !caughtThrow
            : (terminal.kind !== "maybe-throw" || terminal.handler === null) &&
              block.instructions.some((instr) =>
                effectTimingInstructionMayThrow(instr.value, functions, throws),
              );
        if (escapes) {
          throws.set(fn, true);
          changed = true;
          break;
        }
      }
    }
  }
  return throws;
}

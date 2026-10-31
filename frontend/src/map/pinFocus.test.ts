import { describe, expect, it } from "vitest";
import { lightPin, openPin, pinFocus, setPinHover, showPin, subscribePins } from "./pinFocus";

describe("pinFocus", () => {
  it("keeps mouse preview separate from keyboard/list focus", () => {
    lightPin("keyboard-pin");
    expect(pinFocus().hovered).toBeNull();
    setPinHover("mouse-pin");
    expect(pinFocus().hovered).toBe("mouse-pin");
    expect(pinFocus().lit).toBe("keyboard-pin");
    setPinHover(null);
    lightPin(null);
  });
  it("lights, opens and asks for pins, telling listeners once per change", () => {
    let calls = 0;
    const stop = subscribePins(() => {
      calls += 1;
    });
    lightPin("seafood#c0");
    lightPin("seafood#c0");
    expect(pinFocus().lit).toBe("seafood#c0");
    expect(calls).toBe(1);

    openPin("seafood#f1");
    expect(pinFocus()).toMatchObject({ lit: "seafood#c0", open: "seafood#f1" });

    const before = pinFocus().asks;
    showPin("seafood#c2");
    showPin("seafood#c2", true);
    expect(pinFocus()).toMatchObject({ shown: "seafood#c2", asks: before + 2, byKeyboard: true });
    expect(calls).toBe(4);

    stop();
    lightPin(null);
    openPin(null);
    expect(calls).toBe(4);
    expect(pinFocus()).toMatchObject({ lit: null, open: null });
  });
});

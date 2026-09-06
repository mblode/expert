"use client";

import * as React from "react";
import * as RPNInput from "react-phone-number-input";

import { cn } from "@/lib/utils";
import { Input } from "./input";
import type { InputProps } from "./input";
import { NativeSelect, NativeSelectOption } from "./native-select";

type PhoneInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> &
  Omit<RPNInput.Props<typeof RPNInput.default>, "onChange"> & {
    onChange: (value: RPNInput.Value | "") => void;
  };

const PhoneNumberInput = RPNInput.default;

const InputComponent = ({ className, ...props }: InputProps) => (
  <Input className={cn("rounded-s-none!", className)} {...props} />
);

// Adapted from @blode/phone-input. Use the installed native picker so country
// selection keeps the device's keyboard and mobile picker behaviour.
function CountrySelect({
  disabled,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  onChange: (value?: RPNInput.Country) => void;
  options: { label: string; value?: RPNInput.Country }[];
  value?: RPNInput.Country;
}) {
  return (
    <div className="relative w-32 shrink-0">
      <NativeSelect
        aria-label="Country calling code"
        className="rounded-e-none! border-r-0 text-transparent [&_option]:text-foreground"
        disabled={disabled}
        value={value ?? ""}
        onChange={(event) =>
          onChange((event.target.value || undefined) as RPNInput.Country | undefined)
        }
      >
        {options.map((option) => (
          <NativeSelectOption key={option.value ?? "international"} value={option.value ?? ""}>
            {option.value
              ? `${option.label} (+${RPNInput.getCountryCallingCode(option.value)})`
              : option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-[var(--field-padding-x)] flex items-center text-sm"
      >
        {value ? `${value} +${RPNInput.getCountryCallingCode(value)}` : "Intl."}
      </span>
    </div>
  );
}

export function PhoneInput({ className, onChange, ...props }: PhoneInputProps) {
  return (
    <PhoneNumberInput
      className={cn("flex min-w-0", className)}
      countrySelectComponent={CountrySelect}
      inputComponent={InputComponent}
      onChange={(value) => onChange(value ?? "")}
      {...props}
    />
  );
}

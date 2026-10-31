import type { FieldsetHTMLAttributes, KeyboardEvent, SyntheticEvent } from 'react';

const refuse = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

/** A fieldset whose controls refuse changes while busy without `disabled`, so a focused control keeps focus.
 * `disabled` stays native for reasons other than busy (nothing selected). */
export function BusyFieldset({ busy = false, onClickCapture, onChangeCapture, onInputCapture, onDoubleClickCapture, onBlurCapture, onKeyDownCapture, ...rest }: FieldsetHTMLAttributes<HTMLFieldSetElement> & { busy?: boolean }) {
  return (
    <fieldset
      {...rest}
      aria-disabled={busy ? 'true' : undefined}
      onClickCapture={busy ? refuse : onClickCapture}
      onChangeCapture={busy ? refuse : onChangeCapture}
      onInputCapture={busy ? refuse : onInputCapture}
      onDoubleClickCapture={busy ? refuse : onDoubleClickCapture}
      onBlurCapture={busy ? refuse : onBlurCapture}
      onKeyDownCapture={busy ? (event: KeyboardEvent<HTMLFieldSetElement>) => { if (event.key === 'Enter' || event.key === ' ') refuse(event); } : onKeyDownCapture}
    />
  );
}

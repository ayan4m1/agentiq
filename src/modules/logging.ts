import { type TransformableInfo } from 'logform';
import { Container, type Logger, format, transports } from 'winston';

import { logging as config } from './config';

type CustomLogInfo = TransformableInfo & {
  label?: string;
};

const { Console } = transports;
const { combine, label, prettyPrint, printf } = format;

// winston's Container is already a cache keyed by category - add() is what
// registers one and get() returns whatever is registered, creating it only the
// first time. a Map alongside it would be a second copy of the same bookkeeping
const container = new Container();

export const getLogger = (
  category: string,
  categoryLabel = category
): Logger => {
  if (!container.has(category)) {
    container.add(category, {
      transports: [
        new Console({
          level: config.level,
          format: config.detailed
            ? combine(
                label({ label: categoryLabel }),
                prettyPrint(),
                printf(
                  (data: CustomLogInfo) =>
                    `[${data.level}][${data.label}] ${data.message}`
                )
              )
            : prettyPrint()
        })
      ]
    });
  }

  return container.get(category);
};

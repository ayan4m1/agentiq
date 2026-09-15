import { type TransformableInfo } from 'logform';
import { Container, Logger, format, transports } from 'winston';

import { logging as config } from './config.js';

type CustomLogInfo = TransformableInfo & {
  label?: string;
  timestamp?: string;
};

const { Console } = transports;
const { combine, label, prettyPrint, printf } = format;

const loggers = new Map<string, Logger>();
const container = new Container();

const createLogger = (category: string, categoryLabel: string) => {
  const formatters = [label({ label: categoryLabel })];

  formatters.push(
    prettyPrint(),
    printf(
      (data: CustomLogInfo) => `[${data.level}][${data.label}] ${data.message}`
    )
  );
  container.add(category, {
    transports: [
      new Console({
        level: config.level,
        format: combine(...formatters)
      })
    ]
  });

  return container.get(category);
};

export const getLogger = (category: string, categoryLabel = category) => {
  if (!loggers.has(category)) {
    const newLogger = createLogger(category, categoryLabel);

    loggers.set(category, newLogger);

    return newLogger;
  }

  return loggers.get(category) as Logger;
};

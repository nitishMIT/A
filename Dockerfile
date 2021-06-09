FROM node:14.17-alpine

ADD . /app
WORKDIR /app

# Installing packages
RUN npm install --production

# Building TypeScript files
RUN npm run build:release

FROM node:14.17-alpine

CMD ['npm', 'run', 'start:production']
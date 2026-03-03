FROM node:25

WORKDIR /usr/src/app

COPY ./blogs/package.json ./

RUN npm install --only=production

COPY ./blogs .

RUN npx prisma generate

EXPOSE 3000

CMD ["node", "index.js"]
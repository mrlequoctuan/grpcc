FROM node:alpine

WORKDIR /src

COPY . ./
RUN npm install -g . && npm rebuild

RUN ln -s $PWD/docker-entrypoint.sh /usr/local/bin/ && \
    chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /pb

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["-h"]


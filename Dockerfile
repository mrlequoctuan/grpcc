FROM node:6

RUN npm install -g git+https://github.com/mrlequoctuan/grpcc.git

CMD ["/bin/bash"]

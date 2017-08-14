# Simple-filer

This library allows you to send files(even bigger than your memory allowed) between 2 browsers(Chrome only at this moment). The file data go directly from browserA to browserB using the data chanel of WebRTC as the underlying transport layer.

# Install


# Usage



## Getting Started

## Built with

* [Simple-peer](https://github.com/feross/simple-peer) - Simple WebRTC video/voice and data channels.

## Caveats
Although you can send many files to many peers(or the same peer) at the same time, it's recommended against that. JavaScript is not very efficient at handling binary data.

FileSystem API quota

## License

This project is licensed under the [MIT License](/LICENSE.md).

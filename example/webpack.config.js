const path = require('path');
const webpack = require('webpack');

const config = {
  devtool: 'source-map',
  entry: {
    app: ['./public/javascripts/src/demo.js'],
  },
  output: {
    path: path.resolve(__dirname, 'public/javascripts'),
    filename: 'bundle.js'
  },
  module: {
    /*
    rules: [
      {
        test: /\.scss$/,
        include: /scss/,
        loaders: ['style-loader', 'css-loader', 'sass-loader'],
      },
      {
        test: /\.(jpe?g|gif|png|ico|svg)$/i,
        loader:'url-loader?limit=1024&name=images/[name].[ext]'
      },
      {
        test: /\.(woff|woff2|eot|ttf|svg)(\?.*$|$)/i,
        loader: 'url-loader?limit=10240&name=../fonts/[name].[ext]'
      }
    ]
    */
  },

  plugins: [
    new webpack.DefinePlugin({
      'process.env':{
        'NODE_ENV': JSON.stringify('development'),
      }
    })
  ]
};
module.exports = config;

const path = require('path');
const webpack = require('webpack');
var ExtractTextPlugin = require('extract-text-webpack-plugin');

const config = {
  devtool: 'source-map',
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, './'),
    filename: 'simple-filer.min.js'
  },
  module: {
    loaders: [
      {
        test: /\.jsx?$/,
        exclude: /(node_modules|bower_components)/,
        loader: 'babel',
        query: {
          presets: ['es2015', 'stage-2'],
          plugins: [
            "transform-es2015-block-scoping",
            "transform-class-properties",
            "transform-es2015-computed-properties"
          ]
        }
      },
      {
        test: /\.scss$/,
        include: /scss/,
        loaders: ['css', 'autoprefixer?browsers=last 3 versions', 'sass?outputStyle=expanded']
      },
      { test: /\.json$/, loaders: ['json']},
      { test: /\.(jpe?g|gif|png|ico|svg)$/i, loader:'url-loader?limit=1024&name=images/[name].[ext]' },
      { test: /\.css$/, loader: ExtractTextPlugin.extract("css")},
      { test: /\.(woff|woff2|eot|ttf|svg)(\?.*$|$)/i, loader: 'url-loader?limit=10240&name=../fonts/[name].[ext]' }
    ]
  },

  plugins: [
    new webpack.optimize.UglifyJsPlugin({
      minimize: true,
      compress:{warnings: false}, // drop_console: true // 等到以后代码稳定了, 再drop. 亦可使用 strip-loader, which also strip debug('....'), 亦可用 babel-plugin-remove-console 来drop console.
      comments: false,
      mangle: { // reduce local function and variable names to a minimum.
        screw_ie8: true,
        except: ['$', 'webpackJsonp']
      }
    }),
    new webpack.DefinePlugin({
      'process.env':{
        'NODE_ENV': JSON.stringify('production'),
      }
    })
  ]
};
module.exports = config;

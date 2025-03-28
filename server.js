import express from 'express';
import bodyParser from 'body-parser';
import adminRoutes from './routes/admin.js';
import apiRoutes from './routes/api.js';
import webRoutes from './routes/web.js';
import path from 'path';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { errorHandler } from './middleware/errorHandler.js';
import dotenv from 'dotenv';
dotenv.config();
import { Server } from 'socket.io';
import logger from './logger.js';

const app  = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3434;
// const io = new Server(server);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const corsOptions = {
    origin : [
        'http://192.168.1.87:3000',
        'http://192.168.1.94:3000',
        'http://192.168.1.30:8000',
        'http://192.168.1.7:3333',
        'http://192.168.1.52:3000',
        'http://192.168.1.25:3000',
        'http://192.168.1.52:3333',
        'http://192.168.1.38:1112',
        'http://localhost:3000',
        'http://localhost:3001',
        'http://192.168.1.21:1112',
        'http://192.168.1.87:3434',
        'http://192.168.1.19:3000',
        'http://192.168.1.38:3434/',
        'http://localhost:1112',
        'http://localhost:8000/',
        'https://plusxmail.shunyaekai.com/',
        'http://supro.shunyaekai.tech:8801/',
        'http://localhost:3434',
        'https://plusx.shunyaekai.com/'
    ],
    // origin : "*",
    methods: 'GET, POST, PUT, DELETE',
    credentials: true
};

app.use(cors(corsOptions));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(bodyParser.json());
app.use(cookieParser());



// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);
app.use('/web', webRoutes);

app.get('/.well-known/apple-app-site-association', (req, resp) => {
    return resp.json({
        
        "applinks"    : {
            "apps"    : [],
            "details" : [
                {
                    "appID" : "5X456GQ4TF.com.shunyaekaitechnologies.PLUSXELECTRIC",
                    "paths" : ["/redirect/*", "/*"]
                }
            ]
        }
    });
});

app.get('/pod/id6503144034', (req,res, resp) => {
   res.redirect('https://www.plusxelectric.com');
});

app.get('/pod/id6503144034', (req,res, resp) => {
    res.redirect('https://www.plusxelectric.com');
 });
 

// React build
// app.use(express.static(path.join(__dirname, 'build')));
// app.get('/*', function (req, res) {
//     res.sendFile(path.join(__dirname, 'build', 'index.html'));
// });

app.use(errorHandler);

const server = app.listen(PORT, ()=>{
    console.log(`Server is running on port ${PORT}`);
});


// export const io = new Server(server, {
//     cors: corsOptions 
//   });

// io.on('connection', (socket) => {
//     console.log('A user connected:', socket.id);
  
//     // Send a notification event
//     setInterval(() => {
//       socket.emit('desktop-notification', {
//         title: 'Reminder',
//         message: `Hello, this is a notification at ${new Date().toLocaleTimeString()}`,
//       });
//     }, 300000); // Every 5 min 
  
//     socket.on('disconnect', () => {
//       console.log('User disconnected:', socket.id);
//     });
//   });

// io.on('connection', (socket) => {
//   console.log('A user connected:', socket.id);

//   socket.on('disconnect', () => {
//     console.log('User disconnected:', socket.id);
//   });
// });

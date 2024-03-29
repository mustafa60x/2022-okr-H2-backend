import { RoomService } from './../modules/room/room.service';
import { UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AuthGuard } from '@nestjs/passport';
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Model } from 'mongoose';
import { Socket } from 'socket.io';
import { WsGuard } from '../guard/ws.guard';
import { Room } from '../models/room.model';
import { User } from '../models/users.model';

@WebSocketGateway(8081, { cors: '*' })
export class ChatGateway {
  constructor(
    private roomService: RoomService,
    @InjectModel('room') private readonly roomModel: Model<Room>,
    @InjectModel('user') private readonly userModel: Model<User>,
  ) {}

  @WebSocketServer()
  server;

  afterInit() {
    console.log('Gateway initialized');
  }

  async handleConnection(client: Socket) {
    console.log('Connectted: ', client.id);
    const user = await this.userModel.findOne({ clientId: client.id });
    if (user) {
      this.server.emit('users-changed', { user: user.username, event: 'left' });
      user.clientId = null;
      await this.userModel.findByIdAndUpdate(user._id, user);
    }
  }

  async handleDisconnect(client: Socket) {
    console.log('disconnect...');
    const user = await this.userModel.findOne({ clientId: client.id });
    if (user) {
      this.server.emit('users-changed', { user: user.username, event: 'left' });
      user.clientId = null;
      await this.userModel.findByIdAndUpdate(user._id, user);
    }
  }

  @UseGuards(WsGuard)
  @SubscribeMessage('start_chat')
  async startChat(client: Socket, selectedUser): Promise<any> {
    const username = client['user'].username;
    const id = client['user']._id;
    // console.log({ selectedUser });
    // this.roomModel.findOne()
    // const user = await this.roomModel.findOne({ $or:[ {'_id': userId }, {'username':userId} ]}).select('-password -createdAt -updatedAt -tokens -__v').populate('tags', '_id name').exec()
    const room = await this.roomModel
      .findOne({
        $or: [
          {
            $and: [
              { 'messages.senderId': selectedUser._id },
              { 'messages.receiverId': id },
            ],
          },
          {
            $and: [
              { 'messages.senderId': id },
              { 'messages.receiverId': selectedUser._id },
            ],
          },
        ],
      })
      .select('-createdAt -updatedAt -__v')
      .exec();


    if (!room) {
      const room = await this.roomModel.create({
        type: 1,
        messages: [
          {
            text: `${username} sohbeti başlattı.`,
            senderId: id,
            receiverId: selectedUser._id,
            status: 1,
            type: 'join'
          },
        ],
        participants: [id, selectedUser._id],
        // receiverId: selectedUser._id
      });

      const userRoomDetails = await this.roomService.getUserRoom(
        selectedUser?._id,
        room._id,
      );


      // diğer kullanıcıyı bilgilendir
      this.server.emit(`new_request:${selectedUser?._id}`, userRoomDetails);

      return !!room ? room : false;
    }

    return !!room ? room : false;
    // this.server.emit('general_chat', {text: `${username} katıldı.`, username, _id: id, type: 'join' });
  }

  @UseGuards(WsGuard)
  @SubscribeMessage('joined_general_chat')
  joinedGeneralChat(client: Socket): void {
    const username = client['user'].username;
    const id = client['user']._id;
    /* console.log(client["user"].username);
    console.log(client["user"]._id); */
    this.server.emit('entered_to_general_chat', {
      text: `${username} katıldı.`,
      username,
      _id: id,
      type: 'join',
      roomId: '000111',
    });
  }

  @UseGuards(WsGuard)
  @SubscribeMessage('send_message_general_chat')
  sendMessageGeneralChat(client: Socket, data): void {
    // console.log('client', client["user"])
    const username = client['user'].username;
    const id = client['user']._id;

    const { text, roomId, receiverId } = data;

    this.server.emit('received_message_from_general_chat', {
      text: data.text,
      username,
      senderId: id,
      type: 'message',
      roomId,
      receiverId,
    });
  }

  @UseGuards(WsGuard)
  @SubscribeMessage('join_to_room')
  joinToRoom(client: Socket, data): void {
    /* const username = client['user'].username;
    const id = client['user']._id; */

    const { roomId } = data;

    const roomName = '@room:' + roomId;
    client.join(roomName);

    client.to(roomName).emit('test', 'join oldunuz');
  }

  @UseGuards(WsGuard)
  @SubscribeMessage('send_private_message')
  async sendPrivateMessage(client: Socket, data) {
    const username = client['user'].username;
    const id = client['user']._id;

    const { text, roomId, receiverId } = data;
    console.log({ roomId });

    // Yeni mesajı database'e ekler.
    await this.roomModel.findOneAndUpdate(
      { _id: roomId },
      {
        $push: {
          messages: {
            text: text,
            senderId: id,
            receiverId: receiverId,
            status: 1,
            type: 'message'
          },
        },
        $set:{ updatedAt: Date.now }
      },
      { new: true },
    ).lean();

    const roomName = '@room:' + roomId;
    this.server.to(roomName).emit('receive_private_message', {
      text: text,
      username,
      senderId: id,
      type: 'message',
      roomId,
      receiverId,
    });
  }

  @UseGuards(WsGuard)
  @SubscribeMessage('message')
  handleMessage(@MessageBody() message: string, payload: any): void {
    // console.log(message);
    this.server.emit('message', message);
  }

  @SubscribeMessage('enter-chat-room')
  async enterChatRoom(
    client: Socket,
    data: { nickname: string; roomId: string },
  ) {
    let user = await this.userModel.findOne({ nickname: data.nickname });

    if (!user) {
      user = await this.userModel.create({
        nickname: data.nickname,
        clientId: client.id,
      });
    } else {
      user.clientId = client.id;
      user = await this.userModel.findByIdAndUpdate(user._id, user, {
        new: true,
      });
    }
    client.join(data.roomId);
    client.broadcast
      .to(data.roomId)
      .emit('users-changed', { user: user.username, event: 'joined' });
  }

  @SubscribeMessage('leave-chat-room')
  async leaveChatRoom(
    client: Socket,
    data: { nickname: string; roomId: string },
  ) {
    const user = await this.userModel.findOne({ nickname: data.nickname });
    client.broadcast
      .to(data.roomId)
      .emit('users-changed', { user: user.username, event: 'left' });
    client.leave(data.roomId);
  }
}
